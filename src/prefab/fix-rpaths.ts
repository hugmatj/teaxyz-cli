import useCellar from "../hooks/useCellar.ts"
import usePlatform from "../hooks/usePlatform.ts"
import { Path, PackageRequirement, Installation } from "types"
import { runAndGetOutput,run } from "utils"


if (import.meta.main) {
  console.log(await get_rpaths(new Path(Deno.args[0])))
}


//TODO this is not resilient to upgrades (obv)
//NOTE solution is to have the rpath reference major version (or more specific if poss)

/// fix rpaths or install names for executables and dynamic libraries
export default async function fix_rpaths(installation: Installation, pkgs: PackageRequirement[]) {
  console.info("doing SLOW rpath fixes…")
  for await (const [exename, type] of exefiles(installation.path)) {
    await set_rpaths(exename, type, pkgs, installation)
  }
}

const platform = usePlatform().platform


//TODO it's an error if any binary has bad rpaths before bottling
//NOTE we should have a `safety-inspector` step before bottling to check for this sort of thing
//  and then have virtual env manager be more specific via (DY)?LD_LIBRARY_PATH
//FIXME somewhat inefficient for eg. git since git is mostly hardlinks to the same file
async function set_rpaths(exename: Path, type: 'exe' | 'lib', pkgs: PackageRequirement[], installation: Installation) {
  const cellar = useCellar()
  const our_rpaths = await Promise.all(pkgs.map(pkg => prefix(pkg)))

  const cmd = await (async () => {
    switch (platform) {
    case 'linux': {
      //FIXME we need this for perl
      // however really we should just have an escape hatch *just* for stuff that sets its own rpaths
      const their_rpaths = (await runAndGetOutput({
        cmd: ["patchelf", "--print-rpath", exename],
      })).split(":")

      //TODO this isn't enough, we need to de-dupe etc and that
      const rpaths = [...their_rpaths, ...our_rpaths]
        .compactMap(x => x.chuzzle())  // somehow we can get empties from the above
        .map(x => transform(new Path(x), installation))
        .uniq()
        .join(':')
        ?? []

      //FIXME use runtime-path since then LD_LIBRARY_PATH takes precedence which our virtual env manager requires
      return ["patchelf", "--force-rpath", "--set-rpath", rpaths, exename]
    }
    case 'darwin': {
      const rpath = cellar.prefix.relative({ to: exename.parent() })
      const args: (string | Path)[] = [
        "install_name_tool"
      ]

      // both types need rpath set or things linking to eg. independent libs
      // will fail to find the transitive shit, especially in configure scripts

      if (type == 'lib') {
        // we can't trust the id the build system picked
        // we need dependents to correctly link to this dylib
        // and they often use the `id` to do so
        // we tried setting it to @rpath/project/dir/lib but that was probematic since linked executables wouldn’t find the libs at *runtime*
        //TODO possibly should transform to the major of this…
        args.push(...[
          "-id", exename!
        ])
      }

      for (const old_path of await get_bad_otool_listings(exename, type) ?? []) {
        const dylib = await find_dylib(old_path, installation)
        if (!dylib) throw new Error()
        //TODO ^^ probs should look through deps too

        const new_path = (() => {
          if (dylib.string.startsWith(installation.path.string)) {
            const relname = dylib.relative({ to: exename.parent() })
            return `@loader_path/${relname}`
          } else {
            const transformed = transform(dylib, installation)
            return `@rpath/${transformed.relative({ to: cellar.prefix })}`
          }
        })()

        args.push("-change", old_path, new_path)
      }

      if (args.length == 1) return []

      // install_name_tool barfs if the rpath already exists
      if (!(await get_rpaths(exename)).includes(rpath)) {
        args.push("-add_rpath", `@loader_path/${rpath}`)
      }

      if (args.length == 1) return []

      args.push(exename.string)

      return args
    }
    case 'windows':
      throw new Error()
    }
  })()

  if (cmd.length) {
    await run({ cmd })
  }

  async function prefix(pkg: PackageRequirement) {
    return (await cellar.resolve(pkg)).path.join("lib").string
  }
}

async function get_rpaths(exename: Path): Promise<string[]> {
  //GOOD_1ST_ISSUE better tokenizer for the output

  const lines = (await runAndGetOutput({
    cmd: ["otool", "-l", exename]
  }))
    .trim()
    .split("\n")
  const it = lines.values()
  const rv: string[] = []
  for (const line of it) {
    if (line.trim().match(/^cmd\s+LC_RPATH$/)) {
      it.next()
      rv.push(it.next().value.trim().match(/^path\s+(.+)$/)[1])

      console.debug(rv.slice(-1)[0])
    }
  }
  return rv
}

async function find_dylib(name: string, installation: Installation) {
  if (name.startsWith("/")) {
    return new Path(name)
  } else {
    for await (const [path, {name: basename}] of installation.path.join("lib").ls()) {
      if (basename == name) return path
    }
  }
}

async function get_bad_otool_listings(exename: Path, type: 'exe' | 'lib'): Promise<string[]> {
  const cellar = useCellar()

  const lines = (await runAndGetOutput({
    cmd: ["otool", "-L", exename]
  }))
    .trim()
    .split("\n")
    .slice(type == 'lib' ? 2 : 1)  // dylibs list themselves on 1st and 2nd lines

  const rv: string[] = []
  for (const line of lines) {
    console.debug(line)
    const match = line.match(/\t(.+) \(compatibility version/)
    if (!match) throw new Error()
    const dylib = match[1]
    if (dylib.startsWith(cellar.prefix.string)) {
      rv.push(dylib)
    }
    if (dylib.startsWith("@")) {
      console.warn("build created its own special dyld entry: " + dylib)
    } else if (!dylib.startsWith("/")) {
      rv.push(dylib)
    }
  }
  return rv
}

//FIXME pretty slow since we execute `file` for every file
// eg. perl has hundreds of `.pm` files in its `lib`
async function* exefiles(prefix: Path): AsyncGenerator<[Path, 'exe' | 'lib']> {
  for (const basename of ["bin", "lib", "libexec"]) {
    const d = prefix.join(basename).isDirectory()
    if (!d) continue
    for await (const [exename, { isFile, isSymlink }] of d.walk()) {
      if (!isFile || isSymlink) continue
      const type = await exetype(exename)
      if (type) yield [exename, type]
    }
  }
}

async function exetype(path: Path): Promise<'exe' | 'lib' | false> {
  const out = await runAndGetOutput({
    cmd: ["file", "--mime-type", path.string]
  })
  const lines = out.split("\n")
  const line1 = lines[0]
  if (!line1) throw new Error()
  const match = line1.match(/: (.*)$/)
  if (!match) throw new Error()
  const mime = match[1]

  console.debug(mime)

  switch (mime) {
  case 'application/x-pie-executable':
  case 'application/x-mach-binary':
  case 'application/x-executable':
    if (platform == 'darwin') {
      //FIXME on darwin the `file` utility returns x-mach-binary for both binary types
      return path.extname() == ".dylib" ? 'lib' : 'exe'
    } else {
      return 'exe'
    }
  case 'application/x-sharedlib':
    return 'lib'
  default:
    return false
  }
}

// convert a full version path to a major’d version path
// this so we are resilient to upgrades without requiring us to rewrite binaries on install
// since rewriting binaries would invalidate our signatures
function transform(input: Path, installation: Installation) {
  if (input.string.startsWith(installation.path.parent().string)) {
    // don’t transform stuff that links to this actual package
    return input
  } else {
    //FIXME not very robust lol
    return new Path(input.string.replace(/v(\d+)\.\d+\.\d+/, 'v$1'))
  }
}