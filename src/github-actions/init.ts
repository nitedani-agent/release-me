export { init }

// `$ pnpm exec release-me init [--npm] [--github]` sets up release-me on behalf of the user (see ./steps.ts: it lists all
// steps at once, then runs the ones the user keeps): it creates (or updates) .github/workflows/release-npm.yml and/or
// .github/workflows/release-github.yml (see getWorkflowFilesToInit()), the package.json fields the GitHub Actions require,
// the commit, npm's trusted publishers, the push, the commit release that persists the new trusted publishers, and the
// first sync of GitHub Releases.

import * as fs from 'fs'
import pc from '@brillout/picocolors'
import { githubReleaseSync } from './release-github/cli/github-release-sync.ts'
import { getGitHubToken } from './release-github/utils/github-env.ts'
import {
  getCommitReleaseStep,
  getConnectStep,
  getPackagesLabel,
  logConnected,
  type ConnectStep,
} from './release-npm/connectionSteps.ts'
import { getPublishingStatus, type PublishingStatus } from './release-npm/npmRegistry.ts'
import { getNpmUnavailableReason } from './release-npm/npmTrust.ts'
import { getDeleteTrustedPublisherManual, getTrustedPublisherManual } from './release-npm/trustedPublisher.ts'
import { githubReleaseSyncCommand, initCommand, npmConnectionCommand } from './commands.ts'
import {
  assertPnpm,
  getInstallSteps,
  getLockfilePath,
  getPackageJsonSteps,
  resolvePrivatePackages,
  type PackageJsonStep,
} from './packageJsonSteps.ts'
import { logManualSteps, runSteps, type Step, type StepOutcome } from './steps.ts'
import { getGitHubRepo, noGitHubRepoMessage } from './utils/githubRepo.ts'
import { getCurrentBranch, getDefaultBranch, gitFetch, gitPush, isAheadOfOrigin, isBehindOrigin } from './utils/git.ts'
import {
  getWorkflowFilesToInit,
  releaseGitHubWorkflowFile,
  releaseNpmWorkflowFile,
  getWorkflowFileChanges,
  writeWorkflowFile,
  type WorkflowFileOptions,
  type WriteResult,
} from './workflowFiles.ts'
import {
  assertInstalledAtRoot,
  getFilesInsideDir,
  getMonorepoRootDir,
  getReleaseMePackages,
  thisPackageName,
  type ReleaseMePackage,
} from '../releaseMe.ts'
import { isTerminal } from '../utils/ask.ts'
import { formatHint, highlightCommand, logCommand, logDetail, logTitle, run } from '../utils.ts'

async function init(options: WorkflowFileOptions) {
  const monorepoRootDir = await getMonorepoRootDir()
  assertInstalledAtRoot(monorepoRootDir, { isInit: true })
  assertPnpm(monorepoRootDir)
  const filesMonorepo = await getFilesInsideDir(monorepoRootDir)
  const { packages, steps: privatePackageSteps } = await resolvePrivatePackages(
    monorepoRootDir,
    getReleaseMePackages(filesMonorepo, { allowPrivate: true }),
  )
  const packageNames = packages.map(({ packageName }) => packageName)
  const repo = await getGitHubRepo(monorepoRootDir)

  const results = getWorkflowFileChanges(monorepoRootDir, getWorkflowFilesToInit(monorepoRootDir, options))
  logWorkflowFiles(results)
  const releaseNpmResult = results.find(({ workflowFile }) => workflowFile === releaseNpmWorkflowFile)
  const releaseGitHubResult = results.find(({ workflowFile }) => workflowFile === releaseGitHubWorkflowFile)

  // The steps, in order: all of them are listed at once (the user unchecks the ones they don't want), then run
  const workflowFileSteps = results.flatMap((result) =>
    result.status === 'up-to-date' ? [] : [getWorkflowFileStep(monorepoRootDir, result)],
  )
  const packageJsonSteps = [
    ...privatePackageSteps,
    ...(await getInstallSteps(monorepoRootDir, filesMonorepo)),
    ...(await getPackageJsonSteps(monorepoRootDir, packages, repo, !!releaseNpmResult)),
  ]
  const commitStep = getCommitStep(monorepoRootDir, workflowFileSteps, packageJsonSteps)
  const npm = releaseNpmResult ? await getNpmSteps(packages, repo, releaseNpmResult) : null
  const connectSteps = npm?.connectSteps ?? []
  const pushStep = await getPushStep(monorepoRootDir, repo, commitStep)
  const releaseNpmStep = workflowFileSteps.find(({ change }) => change === releaseNpmResult) ?? null
  const commitReleaseStep =
    npm && repo
      ? await getCommitReleaseStep(monorepoRootDir, {
          repo,
          allPackageNames: packageNames,
          connectSteps,
          packageJsonSteps,
          setupSteps: [
            ...(releaseNpmStep
              ? [{ step: releaseNpmStep, requirement: `an up-to-date ${pc.bold(releaseNpmWorkflowFile.fileName)}` }]
              : []),
            ...(commitStep ? [{ step: commitStep, requirement: 'the changes to be committed' }] : []),
          ],
          pushStep,
        })
      : null
  // The first sync of GitHub Releases (afterwards, the GitHub Action syncs them upon each CHANGELOG.md change)
  const releaseGitHubStep = workflowFileSteps.find(({ change }) => change === releaseGitHubResult) ?? null
  const syncStep =
    releaseGitHubResult?.status === 'created' && releaseGitHubStep
      ? await getGitHubReleaseSyncStep(releaseGitHubStep)
      : null
  const steps = [
    ...workflowFileSteps,
    ...packageJsonSteps,
    commitStep,
    ...connectSteps,
    pushStep,
    commitReleaseStep,
    syncStep,
  ].filter((step): step is Step => !!step)

  if (steps.some((step) => !step.alwaysRun)) logTitle('Set up')
  const outcomes = await runSteps(steps)
  logConnected(connectSteps, outcomes, packageNames)
  logInitManualSteps(steps, outcomes, npm, commitStep ?? packageJsonSteps.at(-1) ?? null)
}

/** What's to be done of the workflow files (the steps do it) */
function logWorkflowFiles(results: WriteResult[]) {
  logTitle('GitHub Action', true)
  for (const result of results) {
    const filePath = pc.bold(result.workflowFile.filePath)
    if (result.status === 'up-to-date') console.log(`${pc.green('✅')} ${filePath} is up-to-date`)
    else if (result.status === 'created') console.log(`${pc.red('❌')} ${filePath} is missing`)
    else if (result.status === 'updated') console.log(`${pc.red('❌')} ${filePath} is outdated`)
    else if (result.status === 'renamed')
      console.log(`${pc.red('❌')} ${filePath} has its old name ${pc.bold(result.old.filePath)}`)
  }
}

type WorkflowFileStep = Step & { change: WriteResult }
/** Creates, updates, or renames a workflow file */
function getWorkflowFileStep(monorepoRootDir: string, change: WriteResult): WorkflowFileStep {
  const { workflowFile } = change
  const filePath = pc.bold(workflowFile.filePath)
  const label =
    change.status === 'renamed'
      ? `Rename ${pc.bold(change.old.filePath)} to ${filePath} ${pc.dim('(and update it)')}`
      : `${change.status === 'created' ? 'Create' : 'Update'} ${filePath}`
  const source = pc.bold(`node_modules/${thisPackageName}/${workflowFile.filePath}`)
  return {
    change,
    label,
    run: async () => {
      writeWorkflowFile(monorepoRootDir, change)
      return true
    },
    manual: `${label}: copy ${source}${
      change.status === 'renamed' ? `, and remove ${pc.bold(change.old.filePath)}` : ''
    } (or run ${pc.bold(initCommand)} in a terminal)`,
  }
}

/** Commits the workflow files and the package.json changes. `null` if there is nothing to commit. */
function getCommitStep(
  monorepoRootDir: string,
  workflowFileSteps: WorkflowFileStep[],
  packageJsonSteps: PackageJsonStep[],
): Step | null {
  const changeSteps = [...workflowFileSteps, ...packageJsonSteps]
  if (changeSteps.every((step) => step.notPossibleReason)) return null
  return {
    label: `Commit the changes ${pc.dim('($ git commit)')}`,
    getNotPossibleReason: (isChecked) => (changeSteps.some(isChecked) ? null : 'there is no change to commit'),
    // The package.json files that the package.json steps changed (and pnpm-lock.yaml)
    run: (isDone) => {
      const doneSteps = packageJsonSteps.filter(isDone)
      const lockfilePath = getLockfilePath(monorepoRootDir)
      return commitChanges(
        monorepoRootDir,
        workflowFileSteps.filter(isDone).map(({ change }) => change),
        [
          ...doneSteps.map((step) => step.packageJsonPath),
          ...(doneSteps.some((step) => step.updatesLockfile) && fs.existsSync(lockfilePath) ? [lockfilePath] : []),
        ],
      )
    },
    manual: `Commit the changes ${highlightCommand('$ git commit')}`,
  }
}

/** The manual steps: the ones of the steps that weren't done, the ones of npm's trusted publishers, then the hints */
function logInitManualSteps(
  steps: Step[],
  outcomes: Map<Step, StepOutcome>,
  npm: NpmSteps | null,
  /** The manual steps of npm's trusted publishers come after it */
  lastChangeStep: Step | null,
) {
  const manualNpm = npm?.getManual(outcomes) ?? []
  const hints = [
    ...(npm?.getHints(outcomes) ?? []),
    // Without terminal, release-me can't ask which steps to run
    !isTerminal() &&
      steps.some((step) => !step.alwaysRun && !step.notPossibleReason) &&
      formatHint(`To let release-me do it for you, run ${pc.bold(initCommand)} in a terminal`),
  ].filter((hint): hint is string => !!hint)
  const before = lastChangeStep ? steps[steps.indexOf(lastChangeStep) + 1] : steps[0]
  logManualSteps(steps, outcomes, { manual: manualNpm, before, hints })
}

async function commitChanges(monorepoRootDir: string, changes: WriteResult[], otherFilePaths: string[]) {
  // A renamed workflow file: also its removed old file
  const filePaths = [
    ...changes.flatMap((change) =>
      change.status === 'renamed'
        ? [change.old.filePath, change.workflowFile.filePath]
        : [change.workflowFile.filePath],
    ),
    ...new Set(otherFilePaths),
  ]
  if (filePaths.length === 0) return true
  const commitMessage = changes.some(({ status }) => status === 'created')
    ? 'ci: set up release-me GitHub Action'
    : changes.length > 0
      ? 'ci: update release-me GitHub Action'
      : // Only package.json changes (the workflow files are up-to-date)
        'chore: set up release-me'
  await run(['git', 'add', '--', ...filePaths], { cwd: monorepoRootDir })
  // Only commit these files (`$ git commit -- <file>` ignores other staged changes)
  await run(['git', 'commit', '--quiet', '-m', commitMessage, '--', ...filePaths], { cwd: monorepoRootDir })
  console.log(`Committed ${pc.dim(`(${commitMessage})`)}`)
  return true
}

/** Pushes the commit to the default branch: the GitHub Actions run the workflow files of the default branch */
async function getPushStep(
  monorepoRootDir: string,
  repo: string | null,
  commitStep: Step | null,
): Promise<Step | null> {
  const defaultBranch = await getDefaultBranch(monorepoRootDir)
  const branch = await getCurrentBranch(monorepoRootDir)
  // Up-to-date origin/<default branch>: whether there is something to push, and whether the push would be rejected
  if (repo && defaultBranch && branch === defaultBranch) await gitFetch(monorepoRootDir, defaultBranch)
  const isBehind = !!branch && (await isBehindOrigin(monorepoRootDir, branch))
  // The default branch has commits to push (e.g. the ones of a previous run)
  const hasCommitsToPush = !!branch && branch === defaultBranch && (await isAheadOfOrigin(monorepoRootDir, branch))
  if (!commitStep && !hasCommitsToPush) return null
  const getNotPossibleReason = () => {
    if (!repo) return `${pc.cyan('origin')} isn't a GitHub repository ${logDetail('$ git remote get-url origin')}`
    if (!branch) return `${pc.cyan('HEAD')} isn't a branch`
    if (!defaultBranch) return `release-me couldn't determine the default branch of ${pc.cyan('origin')}`
    if (branch !== defaultBranch) {
      return `the current branch is ${pc.cyan(branch)}, not the default branch ${pc.cyan(
        defaultBranch,
      )} (GitHub runs the GitHub Actions of the default branch)`
    }
    if (isBehind) {
      return `${pc.cyan(`origin/${branch}`)} has commits that ${pc.cyan(branch)} doesn't have: run ${highlightCommand(
        '$ git pull --rebase',
      )} first`
    }
    return null
  }
  return {
    label: `Push the commit ${pc.dim(`($ git push origin ${defaultBranch ?? branch})`)}`,
    notPossibleReason: getNotPossibleReason(),
    getNotPossibleReason: (isChecked) =>
      !hasCommitsToPush && !(commitStep && isChecked(commitStep)) ? 'there is no commit to push' : null,
    run: async () => {
      // E.g. nothing was committed (the user unchecked all package.json steps)
      if (!(await isAheadOfOrigin(monorepoRootDir, branch!))) return true
      return gitPush(monorepoRootDir, branch!)
    },
    manual: `Push the commit to the default branch ${
      isBehind
        ? `${highlightCommand('$ git pull --rebase')} ${highlightCommand('$ git push')}`
        : highlightCommand('$ git push')
    }`,
  }
}

/** @param releaseGitHubStep The step that creates release-github.yml */
async function getGitHubReleaseSyncStep(releaseGitHubStep: Step): Promise<Step> {
  return {
    getNotPossibleReason: (isChecked) =>
      isChecked(releaseGitHubStep) ? null : `${pc.bold(releaseGitHubWorkflowFile.fileName)} isn't created`,
    label: `Create the GitHub Releases of CHANGELOG.md ${pc.dim(`(one per version, ${githubReleaseSyncCommand})`)}`,
    notPossibleReason: (await getGitHubToken())
      ? null
      : `the environment variable ${pc.bold('GITHUB_TOKEN')} isn't set and the GitHub CLI ${pc.cyan(
          'gh',
        )} isn't logged in: run ${highlightCommand('$ gh auth login')}`,
    run: async () => {
      logCommand(githubReleaseSyncCommand)
      try {
        await githubReleaseSync({ packageArgs: [], dryRun: false })
        return true
      } catch (err) {
        console.log(err instanceof Error ? err.message : err)
        return false
      }
    },
    manual: `Create the GitHub Releases of CHANGELOG.md (one per version): run ${highlightCommand(
      githubReleaseSyncCommand,
    )}`,
  }
}

type NpmSteps = Awaited<ReturnType<typeof getNpmSteps>>
/** The steps that set up the trusted publishers of npm (the ones already set up are left untouched) */
async function getNpmSteps(packages: ReleaseMePackage[], repo: string | null, releaseNpmResult: WriteResult) {
  logTitle('npm trusted publisher')
  const packageNames = packages.map(({ packageName }) => packageName)
  const renamed = releaseNpmResult.status === 'renamed' ? releaseNpmResult.old : null
  // release-me can't connect them: all trusted publishers are set up on npmjs.com
  const isManualOnly = !repo || !!renamed
  const connectSteps: ConnectStep[] = []
  // The packages to publish first
  let notOnNpm: string[] = []

  if (!repo) {
    console.log(noGitHubRepoMessage)
  } else if (renamed) {
    // The trusted publisher of the old workflow still exists, and its releases look like release-npm.yml's
    console.log(
      `${pc.bold(renamed.fileName)} is renamed ${pc.bold(
        releaseNpmWorkflowFile.fileName,
      )} (see below): the connection of ${pc.bold(renamed.fileName)} won't work anymore`,
    )
  } else {
    const statuses = await Promise.all(
      packageNames.map(async (packageName) => ({ packageName, ...(await getPublishingStatus(packageName, repo)) })),
    )
    const withStatus = (status: PublishingStatus['status']) =>
      statuses.filter((s) => s.status === status).map(({ packageName }) => packageName)
    const inUse = withStatus('in-use')
    const toConnect = withStatus('not-in-use')
    notOnNpm = withStatus('not-on-npm')
    if (inUse.length > 0) {
      console.log(`${pc.green('✅')} npm <=> GitHub connection up-to-date${getPackagesLabel(inUse, packageNames)}`)
      console.log(formatHint(`For more info, run ${pc.bold(npmConnectionCommand)}`))
    }
    if (toConnect.length > 0) {
      console.log(
        `${pc.red('❌')} npm <=> GitHub connection not in use yet${getPackagesLabel(toConnect, packageNames)}`,
      )
    }
    for (const { packageName, status } of statuses) {
      if (status === 'not-on-npm') console.log(`${pc.yellow('⚠️')}  ${pc.cyan(packageName)} isn't on npm yet`)
      if (status === 'unknown') console.log(`${pc.yellow('⚠️')}  ${pc.cyan(packageName)}: npm's registry didn't reply`)
    }
    const npmUnavailableReason = toConnect.length > 0 ? await getNpmUnavailableReason() : null
    // Why release-me can't connect it (yet)
    const notPossibleReasons = {
      'not-in-use': npmUnavailableReason,
      'not-on-npm': `it isn't on npm yet: publish its first version manually (${highlightCommand('$ pnpm publish')})`,
      unknown: "npm's registry didn't reply",
    }
    for (const { packageName, status } of statuses) {
      if (status !== 'in-use') connectSteps.push(getConnectStep(packageName, repo, notPossibleReasons[status]))
    }
  }

  return {
    connectSteps,
    /** The manual steps of the trusted publishers that weren't set up */
    getManual(outcomes: Map<Step, StepOutcome>): string[][] {
      const notConnected = isManualOnly
        ? packageNames
        : connectSteps
            .filter((step) => outcomes.get(step) !== 'done')
            .map(({ packageName }) => packageName)
            .filter((p) => !notOnNpm.includes(p))
      const manual: string[][] = notOnNpm.map((packageName) => [
        `Publish the first version of ${pc.cyan(packageName)} manually (${highlightCommand(
          '$ pnpm publish',
        )}), then run ${pc.bold(initCommand)} again`,
      ])
      if (notConnected.length > 0) {
        if (renamed) manual.push(getDeleteTrustedPublisherManual(notConnected, renamed.fileName))
        manual.push(getTrustedPublisherManual(notConnected, repo))
      }
      return manual
    },
    getHints(outcomes: Map<Step, StepOutcome>): string[] {
      const hints: string[] = []
      // `$ pnpm exec release-me npm-connection` requires the GitHub repository
      if (repo && renamed)
        hints.push(formatHint(`To let release-me do it for you, run ${pc.bold(npmConnectionCommand)}`))
      // E.g. npm allows only one trusted publisher per package, and the package already has one
      if (connectSteps.some((step) => outcomes.get(step) === 'failed')) {
        hints.push(formatHint(`To replace the existing connection, run ${pc.bold(npmConnectionCommand)}`))
      }
      return hints
    },
  }
}
