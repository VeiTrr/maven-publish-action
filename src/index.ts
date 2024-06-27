import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as exec from '@actions/exec'
import { globSync } from 'glob'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

async function main(): Promise<void> {
  /**
   * The main function for the action.
   * @returns {Promise<void>} Resolves when the action is complete.
   */
  try {
    const localPath: string = core.getInput('local-repository-path')
    const remoteUrl: string = core.getInput('remote-repository-url')
    const remoteUsername: string = core.getInput('remote-repository-username')
    const remotePassword: string = core.getInput('remote-repository-password')
    let tempDir: string = core.getInput('temp-dir')
    if (!tempDir) {
      tempDir = os.tmpdir()
    }
    core.setSecret(remotePassword)

    const pomFiles = globSync('**/*.pom', {
      cwd: localPath,
      absolute: true
    })

    core.debug(`Found pom files: ${pomFiles}`)

    const mavenSettings = path.join(tempDir, 'maven-settings.xml')
    fs.writeFileSync(
      mavenSettings,
      `
      <settings>
        <servers>
          <server>
            <id>remote-repository</id>
            <username>\${env.REMOTE_REPO_USERNAME}</username>          
            <password>\${env.REMOTE_REPO_PASSWORD}</password>          
          </server>        
        </servers>
      </settings>
      `,
      { encoding: 'utf8' }
    )

    // Restore Maven cache (for plugins)
    const primaryCacheKey = `maven-publish-${process.env['RUNNER_OS']}`
    const cachedPaths = [path.join(os.homedir(), '.m2', 'repository')]
    const matchedCacheKey = await cache.restoreCache(
      cachedPaths,
      primaryCacheKey
    )
    if (matchedCacheKey) {
      core.info(`Cache restored from key: ${matchedCacheKey}`)
    } else {
      core.info(`Maven cache was not found`)
    }

    for (const pomFile of pomFiles) {
      // We need to know the basename to find all the other file-types to deploy
      const pomPath = path.parse(pomFile)
      const folder = pomPath.dir
      const basename = pomPath.name

      const mainArtifact = path.join(folder, `${basename}.jar`)
      if (!fs.existsSync(mainArtifact)) {
        core.warning(`Main artifact not found: ${mainArtifact}`)
        continue
      }

      // Build the maven commandline
      const cmd = [
        '--batch-mode',
        '--settings',
        mavenSettings,
        'org.apache.maven.plugins:maven-deploy-plugin:deploy-file',
        // Maven default is only MD5+SHA-1 while Gradle publishes all
        '-Daether.checksums.algorithms=MD5,SHA-1,SHA-256,SHA-512',
        '-DretryFailedDeploymentCount=3',
        `-Durl=${remoteUrl}`,
        `-DpomFile=${pomFile}`,
        `-Dfile=${mainArtifact}`
      ]

      // Find additional artifacts to deploy
      const ignoredExts = ['.pom', '.md5', '.sha1', '.sha256', '.sha512']
      const extraFiles = []
      const extraClassifiers = []
      const extraTypes = []
      for (const filePath of fs.readdirSync(folder)) {
        // Ignore checksum files
        const parsed = path.parse(filePath)
        if (
          !parsed.name.startsWith(basename) ||
          ignoredExts.includes(parsed.ext) ||
          // We do not support extensionless
          parsed.ext === ''
        ) {
          continue
        }

        const type = parsed.ext.substring(1)
        let classifier = parsed.name.substring(basename.length)
        if (classifier.length > 0 && !classifier.startsWith('-')) {
          continue
        }
        // Skip leading "-" if classifier isn't empty
        if (classifier.length > 0) {
          classifier = classifier.substring(1)
        }

        // Skip the main artifact, since it's already passed
        if (type === 'jar' && classifier === '') {
          continue
        }

        extraFiles.push(filePath)
        extraTypes.push(type)
        extraClassifiers.push(classifier)
      }
      if (extraFiles.length > 0) {
        cmd.push(
          `-Dfiles=${extraFiles.join(',')}`,
          `-Dtypes=${extraTypes.join(',')}`,
          `-Dclassifiers=${extraClassifiers.join(',')}`
        )
      }

      await exec.exec('mvn', cmd, {
        cwd: folder,
        env: {
          REMOTE_REPO_USERNAME: remoteUsername,
          REMOTE_REPO_PASSWORD: remotePassword
        }
      })
    }

    await cache.saveCache(cachedPaths, primaryCacheKey)
    core.info(`Cache saved with the key: ${primaryCacheKey}`)
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

// noinspection JSIgnoredPromiseFromCall
main()
