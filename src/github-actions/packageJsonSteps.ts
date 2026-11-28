export { getPackageJsonSteps }
export { getInstallSteps }
export { setPackageJsonFields }
export { getRepositoryValue }
export { getLockfilePath }
export { assertPnpm }
export { resolvePrivatePackages }
export type { PackageJsonStep }

// The package.json changes that the GitHub Actions of release-me require, as steps of `$ pnpm exec release-me init` (see
// ./steps.ts)

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import execa from 'execa'
import pc from '@brillout/picocolors'
import { getRepositoryMismatch } from './release-npm/githubAction.ts'
import { hasUncommittedChanges } from './utils/git.ts'
import type { Step } from './steps.ts'
import {
  getFilesMonorepoPackageJson,
  getPackageJson,
  getPrivatePackageError,
  hasReleaseScript,
  isReleaseScript,
  noPackageToReleaseError,
  thisPackageName,
  type Files,
  type PackageJson,
  type ReleaseMePackage,
} from '../releaseMe.ts'
import { askQuestion, isTerminal } from '../utils/ask.ts'
import { assertUsage, highlightCommand, logCommand } from '../utils.ts'

type PackageJsonStep = Step & {
  /** The package.json the step changes */
  packageJsonPath: string
  /** What the GitHub Action release-npm.yml requires, e.g. `a build script in package.json` (`null`: it doesn't require the step) */
  requiredByGitHubAction: string | null
  /** The step also updates pnpm-lock.yaml (which is committed along with the package.json) */
  updatesLockfile?: true
}

/** The step that installs release-me at the root (otherwise release-me, and the GitHub Action, abort: see assertInstalledAtRoot()) */
async function getInstallSteps(monorepoRootDir: string, filesMonorepo: Files): Promise<PackageJsonStep[]> {
  const steps: PackageJsonStep[] = []
  const lockfilePath = getLockfilePath(monorepoRootDir)
  const name = pc.cyan(thisPackageName)

  // The GitHub Action runs release-me from the root (`$ pnpm exec release-me ci-publish`)
  const { packageJson: rootPackageJson, packageJsonPath: rootPackageJsonPath } = getPackageJson(monorepoRootDir)
  if (!rootPackageJson.devDependencies?.[thisPackageName] && !rootPackageJson.dependencies?.[thisPackageName]) {
    const fileName = pc.bold(path.relative(monorepoRootDir, rootPackageJsonPath))
    const label = `Add ${name} to the ${pc.bold('devDependencies')} of ${fileName}`
    steps.push({
      packageJsonPath: rootPackageJsonPath,
      label,
      notPossibleReason: await getUncommittedReason(monorepoRootDir, [rootPackageJsonPath, lockfilePath]),
      run: updateWithLockfile(monorepoRootDir, rootPackageJsonPath, {
        devDependencies: addDependency(rootPackageJson.devDependencies, getVersionRange(filesMonorepo)),
      }),
      manual: `${label} ${highlightCommand(`$ pnpm add --save-dev --workspace-root ${thisPackageName}`)}`,
      requiredByGitHubAction: `${name} in the ${pc.bold('devDependencies')} of ${fileName}`,
      updatesLockfile: true,
    })
  }

  return steps
}

/** The version range of release-me: the one of the other package.json files (e.g. `^0.5.9`), or else the installed release-me's */
function getVersionRange(filesMonorepo: Files): string {
  for (const { filePathAbsolute } of getFilesMonorepoPackageJson(filesMonorepo)) {
    const { packageJson } = getPackageJson(path.dirname(filePathAbsolute))
    const range = packageJson.devDependencies?.[thisPackageName] ?? packageJson.dependencies?.[thisPackageName]
    // Not e.g. `link:../release-me` nor `workspace:*`
    if (range && /^[\^~]?\d/.test(range)) return range
  }
  const thisPackageRootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
  return `^${getPackageJson(thisPackageRootDir).packageJson.version}`
}

/** release-me only supports pnpm (e.g. the GitHub Actions install pnpm, and release-me runs `$ pnpm publish`) */
function assertPnpm(monorepoRootDir: string) {
  const { packageJson, packageJsonPath } = getPackageJson(monorepoRootDir)
  const { packageManager, devEngines } = packageJson
  const name = packageManager?.split('@')[0] || devEngines?.packageManager?.name
  const field = packageManager ? 'packageManager' : 'devEngines.packageManager'
  assertUsage(
    !name || name === 'pnpm',
    `${packageJsonPath}#${pc.bold(field)} is ${pc.cyan(name!)}, but release-me only supports ${pc.cyan('pnpm')}.`,
  )
}

/**
 * The packages that have a script that runs release-me but are private: the user chooses to make them public, or to not
 * release them (otherwise release-me aborts, see getReleaseMePackages()).
 * @returns The packages to release, and the steps that apply the user's choices (before the commit)
 */
async function resolvePrivatePackages(
  monorepoRootDir: string,
  packages: ReleaseMePackage[],
): Promise<{ packages: ReleaseMePackage[]; steps: PackageJsonStep[] }> {
  const packagesToRelease: ReleaseMePackage[] = []
  const steps: PackageJsonStep[] = []
  for (const pkg of packages) {
    if (!pkg.isPrivate) {
      packagesToRelease.push(pkg)
      continue
    }
    const { packageJson, packageJsonPath } = getPackageJson(pkg.packageRootDir)
    const name = pc.cyan(pkg.packageName)
    const fileName = pc.bold(path.relative(monorepoRootDir, packageJsonPath))
    const error = getPrivatePackageError(pkg.packageName)
    // Without terminal, release-me can't ask
    assertUsage(isTerminal(), error)
    const uncommittedReason = await getUncommittedReason(monorepoRootDir, [packageJsonPath])
    assertUsage(!uncommittedReason, `${error} (release-me can't do it for you: ${uncommittedReason})`)
    const makePublic = `Make ${name} public ${pc.dim(`(remove "private": true from ${fileName})`)}`
    const dontRelease = `Don't release ${name} ${pc.dim(`(remove its scripts that run release-me from ${fileName})`)}`
    console.log(`${pc.yellow('⚠️')}  ${name} has a script that runs release-me but it's private:`)
    console.log(`  ${pc.bold('1.')} ${makePublic}`)
    console.log(`  ${pc.bold('2.')} ${dontRelease}`)
    const answer = (await askQuestion(pc.blue(pc.bold('Enter 1 or 2 (or <CTRL-C> to abort): '))))?.trim()
    assertUsage(answer === '1' || answer === '2', error)
    if (answer === '1') {
      packagesToRelease.push(pkg)
      steps.push({
        packageJsonPath,
        label: makePublic,
        alwaysRun: true,
        run: async () => {
          setPackageJsonFields(packageJsonPath, { private: undefined })
          return true
        },
        manual: null,
        // ci-publish aborts otherwise
        requiredByGitHubAction: `${name} to be public`,
      })
    } else {
      const scripts = Object.fromEntries(
        Object.entries(packageJson.scripts ?? {}).filter(([, script]) => !isReleaseScript(script)),
      )
      steps.push({
        packageJsonPath,
        label: dontRelease,
        alwaysRun: true,
        run: async () => {
          setPackageJsonFields(packageJsonPath, { scripts })
          return true
        },
        manual: null,
        requiredByGitHubAction: null,
      })
    }
  }
  assertUsage(packagesToRelease.length > 0, noPackageToReleaseError)
  return { packages: packagesToRelease, steps }
}

const releaseScripts = {
  release: 'release-me patch',
  'release:minor': 'release-me minor',
  'release:major': 'release-me major',
  'release:commit': 'release-me commit',
}

/** @param withReleaseNpm Whether the repository uses the GitHub Action release-npm.yml (which requires package.json#repository) */
async function getPackageJsonSteps(
  monorepoRootDir: string,
  packages: ReleaseMePackage[],
  repo: string | null,
  withReleaseNpm: boolean,
): Promise<PackageJsonStep[]> {
  const steps: PackageJsonStep[] = []
  const update = (packageJsonPath: string, fields: Record<string, unknown>) => async () => {
    setPackageJsonFields(packageJsonPath, fields)
    return true
  }

  // The GitHub Actions install the pnpm version of the root package.json (pnpm/action-setup reads it)
  {
    const { packageJson, packageJsonPath } = getPackageJson(monorepoRootDir)
    const { packageManager, devEngines } = packageJson
    const isSet =
      packageManager?.startsWith('pnpm@') ||
      (devEngines?.packageManager?.name === 'pnpm' && !!devEngines.packageManager.version)
    if (!isSet) {
      const pnpmVersion = await getPnpmVersion()
      const value = `pnpm@${pnpmVersion ?? 'x.y.z'}`
      const field = pc.bold(`"packageManager": "${value}"`)
      const fileName = pc.bold(path.relative(monorepoRootDir, packageJsonPath))
      steps.push({
        packageJsonPath,
        label: `Set ${field} in ${fileName}`,
        notPossibleReason: pnpmVersion
          ? await getUncommittedReason(monorepoRootDir, [packageJsonPath])
          : "pnpm isn't installed",
        run: update(packageJsonPath, { packageManager: value }),
        manual: `Set ${field} in ${fileName} (the GitHub Actions install that pnpm version)`,
        requiredByGitHubAction: `${pc.bold('"packageManager"')} in ${fileName}`,
      })
    }
  }

  for (const { packageName, packageRootDir, packageRootDirRelative } of packages) {
    const { packageJson, packageJsonPath } = getPackageJson(packageRootDir)
    const fileName = pc.bold(path.relative(monorepoRootDir, packageJsonPath))

    // No script that runs release-me: the root package of a repository with a single package (see getReleaseMePackages())
    if (!hasReleaseScript(packageJson)) {
      const scripts = { ...releaseScripts, ...packageJson.scripts }
      const example = pc.dim(`("release": "release-me patch", …)`)
      steps.push({
        packageJsonPath,
        label: `Add the release scripts to ${fileName} ${example}`,
        notPossibleReason: await getUncommittedReason(monorepoRootDir, [packageJsonPath]),
        run: update(packageJsonPath, { scripts }),
        manual: `Add the release scripts to ${fileName} ${example}`,
        // The GitHub Action releases the root package of a repository with a single package (see getReleaseMePackages())
        requiredByGitHubAction: null,
      })
    }

    // release-me runs `$ pnpm run build` before releasing: release-me can't know how the package is built
    if (!packageJson.scripts?.build) {
      const build = pc.bold('$ pnpm run build')
      steps.push({
        packageJsonPath,
        label: `Add a ${pc.bold('build')} script to ${fileName}`,
        notPossibleReason: `release-me doesn't know how ${pc.cyan(packageName)} is built`,
        run: async () => false,
        manual: `Add a ${pc.bold(
          'build',
        )} script to ${fileName} (release-me runs ${build} before releasing, e.g. ${pc.bold(
          `"build": "tsc"`,
        )}, or ${pc.bold(`"build": "echo 'No build step'"`)})`,
        // The GitHub Action builds the packages it publishes
        requiredByGitHubAction: `a ${pc.bold('build')} script in ${fileName}`,
      })
    }

    // npm's trusted publishing requires package.json#repository to match the GitHub repository
    if (withReleaseNpm && repo && getRepositoryMismatch(packageName, packageJson.repository, repo)) {
      const repository = getRepositoryValue(packageJson.repository, repo, packageRootDirRelative)
      const url = pc.underline(`https://github.com/${repo}`)
      const field = pc.bold('"repository"')
      const current = typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url
      const detail = `(npm's trusted publishing requires it${current ? `, it's ${current}` : ''})`
      steps.push({
        packageJsonPath,
        label: `Set ${field} of ${fileName} to ${url}`,
        notPossibleReason: await getUncommittedReason(monorepoRootDir, [packageJsonPath]),
        run: update(packageJsonPath, { repository }),
        manual: `Set ${field} of ${fileName} to ${url} ${detail}`,
        requiredByGitHubAction: `${field} of ${fileName} to be ${url}`,
      })
    }
  }
  return steps
}

/** The new package.json#repository: the GitHub repository `repo` (in a monorepo, with the package's directory) */
function getRepositoryValue(
  repository: PackageJson['repository'],
  repo: string,
  packageRootDirRelative: string,
): PackageJson['repository'] {
  const url = `https://github.com/${repo}`
  if (typeof repository === 'object' && repository) return { ...repository, url }
  if (packageRootDirRelative === '.') return url
  return { type: 'git', url, directory: packageRootDirRelative }
}

/** Sets the fields `fields` of the package.json `packageJsonPath` (keeping its indentation, and the order of its fields) */
function setPackageJsonFields(packageJsonPath: string, fields: Record<string, unknown>) {
  const content = fs.readFileSync(packageJsonPath, 'utf8')
  const indent = /^\{\r?\n([ \t]+)"/.exec(content)?.[1] ?? '  '
  const packageJson = { ...JSON.parse(content), ...fields }
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, indent) + '\n')
}

/** The dependencies `dependencies` with release-me (sorted, like `$ pnpm add` does) */
function addDependency(dependencies: Record<string, string> | undefined, version: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...dependencies, [thisPackageName]: version }).sort(([a], [b]) => (a < b ? -1 : 1)),
  )
}

/** Why the files `filePaths` can't be changed (and committed): they have uncommitted changes */
async function getUncommittedReason(monorepoRootDir: string, filePaths: string[]): Promise<string | null> {
  for (const filePath of filePaths) {
    if (await hasUncommittedChanges(monorepoRootDir, [filePath])) {
      return `${pc.bold(path.relative(monorepoRootDir, filePath))} has uncommitted changes`
    }
  }
  return null
}

function getLockfilePath(monorepoRootDir: string) {
  return path.join(monorepoRootDir, 'pnpm-lock.yaml')
}

/** Sets the fields `fields` of the package.json `packageJsonPath`, then updates pnpm-lock.yaml (reverting the package.json if it fails) */
function updateWithLockfile(monorepoRootDir: string, packageJsonPath: string, fields: Record<string, unknown>) {
  return async () => {
    const content = fs.readFileSync(packageJsonPath, 'utf8')
    setPackageJsonFields(packageJsonPath, fields)
    // `--lockfile-only`: see bumpPnpmLockFile()
    const args = ['install', '--lockfile-only']
    logCommand(`$ pnpm ${args.join(' ')}`)
    const { failed } = await execa('pnpm', args, { cwd: monorepoRootDir, stdio: 'inherit', reject: false })
    if (failed) fs.writeFileSync(packageJsonPath, content)
    return !failed
  }
}

async function getPnpmVersion(): Promise<string | null> {
  const { stdout, failed } = await execa('pnpm', ['--version'], { reject: false })
  return failed ? null : stdout.trim()
}
