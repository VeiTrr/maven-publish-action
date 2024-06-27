import * as core from '@actions/core'
import { globSync } from 'glob'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as exec from '@actions/exec'

async function main() {
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

    for (let pomFile of pomFiles) {
      // We need to know the basename to find all the other file-types to deploy
      const pomPath = path.parse(pomFile)
      const folder = pomPath.dir
      const basename = pomPath.name

      const mainArtifact = path.join(folder, basename + '.jar')
      if (!fs.existsSync(mainArtifact)) {
        core.warning('Main artifact not found: ' + mainArtifact)
        continue
      }

      const mavenSettings = path.join(tempDir, 'maven-settings.xml')

      // Build the maven commandline
      let cmd = [
        '-s',
        mavenSettings,
        'org.apache.maven.plugins:maven-deploy-plugin:deploy-file',
        // Maven default is only MD5+SHA-1 while Gradle publishes all
        '-Daether.checksums.algorithms=MD5,SHA-1,SHA-256,SHA-512',
        '-DretryFailedDeploymentCount=3',
        '-Durl=' + remoteUrl,
        '-DpomFile=' + pomFile,
        '-Dfile=' + mainArtifact
      ]

      // Find additional artifacts to deploy
      let ignoredExts = ['.pom', '.md5', '.sha1', '.sha256', '.sha512']
      let extraFiles = []
      let extraClassifiers = []
      let extraTypes = []
      for (let filePath of fs.readdirSync(folder)) {
        // Ignore checksum files
        const parsed = path.parse(filePath)
        if (
          !parsed.name.startsWith(basename) ||
          ignoredExts.includes(parsed.ext) ||
          // We do not support extensionless
          parsed.ext == ''
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
          '-Dfiles=' + extraFiles.join(','),
          '-Dtypes=' + extraTypes.join(','),
          '-Dclassifiers=' + extraClassifiers.join(',')
        )
      }

      await exec.exec('mvn', cmd, {
        cwd: folder
      })
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

// noinspection JSIgnoredPromiseFromCall
main()
