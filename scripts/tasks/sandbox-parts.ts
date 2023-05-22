// This file requires many imports from `../code`, which requires both an install and bootstrap of
// the repo to work properly. So we load it async in the task runner *after* those steps.

/* eslint-disable no-restricted-syntax, no-await-in-loop */
import {
  copy,
  ensureSymlink,
  ensureDir,
  existsSync,
  pathExists,
  readJson,
  writeJson,
} from 'fs-extra';
import { join, resolve, sep } from 'path';

import slash from 'slash';
import type { Task } from '../task';
import { executeCLIStep, steps } from '../utils/cli-step';
import {
  installYarn2,
  configureYarn2ForVerdaccio,
  addPackageResolutions,
  addWorkaroundResolutions,
} from '../utils/yarn';
import { exec } from '../utils/exec';
import type { ConfigFile } from '../../code/lib/csf-tools';
import { writeConfig } from '../../code/lib/csf-tools';
import { filterExistsInCodeDir } from '../utils/filterExistsInCodeDir';
import { findFirstPath } from '../utils/paths';
import { detectLanguage } from '../../code/lib/cli/src/detect';
import { SupportedLanguage } from '../../code/lib/cli/src/project_types';
import { updatePackageScripts } from '../utils/package-json';
import { addPreviewAnnotations, readMainConfig } from '../utils/main-js';
import { JsPackageManagerFactory } from '../../code/lib/cli/src/js-package-manager';
import { workspacePath } from '../utils/workspace';
import { babelParse } from '../../code/lib/csf-tools/src/babelParse';
import { CODE_DIRECTORY, REPROS_DIRECTORY } from '../utils/constants';

const logger = console;

export const essentialsAddons = [
  'actions',
  'backgrounds',
  'controls',
  'docs',
  'highlight',
  'measure',
  'outline',
  'toolbars',
  'viewport',
];

export const create: Task['run'] = async ({ key, template, sandboxDir }, { dryRun, debug }) => {
  const parentDir = resolve(sandboxDir, '..');
  await ensureDir(parentDir);

  if ('inDevelopment' in template && template.inDevelopment) {
    const srcDir = join(REPROS_DIRECTORY, key, 'after-storybook');
    if (!existsSync(srcDir)) {
      throw new Error(`Missing repro directory '${srcDir}', did the generate task run?`);
    }
    await copy(srcDir, sandboxDir);
  } else {
    await executeCLIStep(steps.repro, {
      argument: key,
      optionValues: { output: sandboxDir, branch: 'next', init: false, debug },
      cwd: parentDir,
      dryRun,
      debug,
    });
  }
};

export const install: Task['run'] = async (
  { sandboxDir, template },
  { link, dryRun, debug, addon: addons, skipTemplateStories }
) => {
  const cwd = sandboxDir;
  await installYarn2({ cwd, dryRun, debug });

  if (link) {
    await executeCLIStep(steps.link, {
      argument: sandboxDir,
      cwd: CODE_DIRECTORY,
      optionValues: { local: true, start: false },
      dryRun,
      debug,
    });
    await addWorkaroundResolutions({ cwd, dryRun, debug });
  } else {
    // We need to add package resolutions to ensure that we only ever install the latest version
    // of any storybook packages as verdaccio is not able to both proxy to npm and publish over
    // the top. In theory this could mask issues where different versions cause problems.
    await addPackageResolutions({ cwd, dryRun, debug });
    await configureYarn2ForVerdaccio({ cwd, dryRun, debug });

    await exec(
      'yarn install',
      { cwd },
      {
        debug,
        dryRun,
        startMessage: `⬇️ Installing local dependencies`,
        errorMessage: `🚨 Installing local dependencies failed`,
      }
    );
  }

  let extra = {};
  if (template.expected.renderer === '@storybook/html') extra = { type: 'html' };
  else if (template.expected.renderer === '@storybook/server') extra = { type: 'server' };

  await executeCLIStep(steps.init, {
    cwd,
    optionValues: { debug, yes: true, ...extra },
    dryRun,
    debug,
  });

  logger.info(`🔢 Adding package scripts:`);

  const nodeOptions = [
    process.env.NODE_OPTIONS || '',
    '--preserve-symlinks',
    '--preserve-symlinks-main',
  ].filter(Boolean);

  const pnp = await pathExists(join(cwd, '.pnp.cjs')).catch(() => {});
  if (pnp && !nodeOptions.find((s) => s.includes('--require'))) {
    nodeOptions.push('--require ./.pnp.cjs');
  }

  const nodeOptionsString = nodeOptions.join(' ');
  const prefix = `NODE_OPTIONS='${nodeOptionsString}' STORYBOOK_TELEMETRY_URL="http://localhost:6007/event-log"`;

  await updatePackageScripts({
    cwd,
    prefix,
  });

  switch (template.expected.framework) {
    case '@storybook/angular':
      await prepareAngularSandbox(cwd);
      break;
    default:
  }

  if (!skipTemplateStories) {
    for (const addon of addons) {
      const addonName = `@storybook/addon-${addon}`;
      await executeCLIStep(steps.add, { argument: addonName, cwd, dryRun, debug });
    }
  }
};

// Ensure that sandboxes can refer to story files defined in `code/`.
// Most WP-based build systems will not compile files outside of the project root or 'src/` or
// similar. Plus they aren't guaranteed to handle TS files. So we need to patch in esbuild
// loader for such files. NOTE this isn't necessary for Vite, as far as we know.
function addEsbuildLoaderToStories(mainConfig: ConfigFile) {
  // NOTE: the test regexp here will apply whether the path is symlink-preserved or otherwise
  const esbuildLoaderPath = require.resolve('../../code/node_modules/esbuild-loader');
  const storiesMdxLoaderPath = require.resolve(
    '../../code/node_modules/@storybook/mdx2-csf/loader'
  );
  const babelLoaderPath = require.resolve('babel-loader');
  const jsxPluginPath = require.resolve('@babel/plugin-transform-react-jsx');
  const webpackFinalCode = `
  (config) => ({
    ...config,
    module: {
      ...config.module,
      rules: [
        // Ensure esbuild-loader applies to all files in ./template-stories
        {
          test: [/\\/template-stories\\//],
          exclude: [/\\.mdx$/],
          loader: '${esbuildLoaderPath}',
          options: {
            loader: 'tsx',
            target: 'es2015',
          },
        },
        // Handle MDX files per the addon-docs presets (ish)
        {
          test: [/\\/template-stories\\//],
          include: [/\\.stories\\.mdx$/],
          use: [
            {
              loader: '${babelLoaderPath}',
              options: {
                babelrc: false,
                configFile: false,
                plugins: ['${jsxPluginPath}'],
              }
            },
            {
              loader: '${storiesMdxLoaderPath}',
              options: {
                skipCsf: false,
              }
            }
          ],
        },
        {
          test: [/\\/template-stories\\//],
          include: [/\\.mdx$/],
          exclude: [/\\.stories\\.mdx$/],
          use: [
            {
              loader: '${babelLoaderPath}',
              options: {
                babelrc: false,
                configFile: false,
                plugins: ['${jsxPluginPath}'],
              }
            },
            {
              loader: '${storiesMdxLoaderPath}',
              options: {
                skipCsf: true,
              }
            }
          ],
        },
        // Ensure no other loaders from the framework apply
        ...config.module.rules.map(rule => ({
          ...rule,
          exclude: [/\\/template-stories\\//].concat(rule.exclude || []),
        })),
      ],
    },
  })`;
  mainConfig.setFieldNode(
    ['webpackFinal'],
    babelParse(webpackFinalCode).program.body[0].expression
  );
}

/*
  Recompile optimized deps on each startup, so you can change @storybook/* packages and not
  have to clear caches.
  And allow source directories to complement any existing allow patterns
  (".storybook" is already being allowed by builder-vite)
*/
function setSandboxViteFinal(mainConfig: ConfigFile) {
  const viteFinalCode = `
  (config) => ({
    ...config,
    optimizeDeps: { ...config.optimizeDeps, force: true },
    server: {
      ...config.server,
      fs: {
        ...config.server?.fs,
        allow: ['stories', 'src', 'template-stories', 'node_modules', ...(config.server?.fs?.allow || [])],
      },
    },
  })`;
  mainConfig.setFieldNode(['viteFinal'], babelParse(viteFinalCode).program.body[0].expression);
}

// Update the stories field to ensure that no TS files
// that are linked from the renderer are picked up in non-TS projects
function updateStoriesField(mainConfig: ConfigFile, isJs: boolean) {
  const stories = mainConfig.getFieldValue(['stories']) as string[];

  // If the project is a JS project, let's make sure any linked in TS stories from the
  // renderer inside src|stories are simply ignored.
  const updatedStories = isJs
    ? stories.map((specifier) => specifier.replace('js|jsx|ts|tsx', 'js|jsx'))
    : stories;

  mainConfig.setFieldValue(['stories'], [...updatedStories]);
}

// Add a stories field entry for the passed symlink
function addStoriesEntry(mainConfig: ConfigFile, path: string) {
  const stories = mainConfig.getFieldValue(['stories']) as string[];

  const entry = {
    directory: slash(join('../template-stories', path)),
    titlePrefix: slash(path),
    files: '**/*.@(mdx|stories.@(js|jsx|ts|tsx))',
  };

  mainConfig.setFieldValue(['stories'], [...stories, entry]);
}

function getStoriesFolderWithVariant(variant?: string, folder = 'stories') {
  return variant ? `${folder}_${variant}` : folder;
}

// packageDir is eg 'renderers/react', 'addons/actions'
async function linkPackageStories(
  packageDir: string,
  { mainConfig, cwd, linkInDir }: { mainConfig: ConfigFile; cwd: string; linkInDir?: string },
  variant?: string
) {
  const storiesFolderName = variant ? getStoriesFolderWithVariant(variant) : 'stories';
  const source = join(CODE_DIRECTORY, packageDir, 'template', storiesFolderName);
  // By default we link `stories` directories
  //   e.g '../../../code/lib/store/template/stories' to 'template-stories/lib/store'
  // if the directory <code>/lib/store/template/stories exists
  //
  // The files must be linked in the cwd, in order to ensure that any dependencies they
  // reference are resolved in the cwd. In particular 'react' resolved by MDX files.
  const target = linkInDir
    ? resolve(linkInDir, variant ? getStoriesFolderWithVariant(variant, packageDir) : packageDir)
    : resolve(cwd, 'template-stories', packageDir);

  await ensureSymlink(source, target);

  if (!linkInDir) {
    addStoriesEntry(mainConfig, packageDir);
  }

  // Add `previewAnnotation` entries of the form
  //   './template-stories/lib/store/preview.[tj]s'
  // if the file <code>/lib/store/template/stories/preview.[jt]s exists
  await Promise.all(
    ['js', 'ts'].map(async (ext) => {
      const previewFile = `preview.${ext}`;
      const previewPath = join(
        CODE_DIRECTORY,
        packageDir,
        'template',
        storiesFolderName,
        previewFile
      );
      if (await pathExists(previewPath)) {
        let storiesDir = 'template-stories';
        if (linkInDir) {
          storiesDir = (await pathExists(join(cwd, 'src/stories'))) ? 'src/stories' : 'stories';
        }
        addPreviewAnnotations(mainConfig, [
          `./${join(storiesDir, variant ? `${packageDir}_${variant}` : packageDir, previewFile)}`,
        ]);
      }
    })
  );
}

async function addExtraDependencies({
  cwd,
  dryRun,
  debug,
}: {
  cwd: string;
  dryRun: boolean;
  debug: boolean;
}) {
  // web-components doesn't install '@storybook/testing-library' by default
  const extraDeps = [
    '@storybook/jest@future',
    '@storybook/testing-library@future',
    '@storybook/test-runner@future',
  ];
  if (debug) logger.log('🎁 Adding extra deps', extraDeps);
  if (!dryRun) {
    const packageManager = JsPackageManagerFactory.getPackageManager({}, cwd);
    await packageManager.addDependencies({ installAsDevDependencies: true }, extraDeps);
  }
}

export const addStories: Task['run'] = async (
  { sandboxDir, template, key },
  { addon: extraAddons, dryRun, debug }
) => {
  logger.log('💃 adding stories');
  const cwd = sandboxDir;
  const storiesPath = await findFirstPath([join('src', 'stories'), 'stories'], { cwd });

  const mainConfig = await readMainConfig({ cwd });

  // Ensure that we match the right stories in the stories directory
  const packageJson = await import(join(cwd, 'package.json'));
  updateStoriesField(mainConfig, detectLanguage(packageJson) === SupportedLanguage.JAVASCRIPT);

  const isCoreRenderer =
    template.expected.renderer.startsWith('@storybook/') &&
    template.expected.renderer !== '@storybook/server';

  const sandboxSpecificStoriesFolder = key.replaceAll('/', '-');
  const storiesVariantFolder = getStoriesFolderWithVariant(sandboxSpecificStoriesFolder);

  if (isCoreRenderer) {
    // Link in the template/components/index.js from store, the renderer and the addons
    const rendererPath = await workspacePath('renderer', template.expected.renderer);
    await ensureSymlink(
      join(CODE_DIRECTORY, rendererPath, 'template', 'components'),
      resolve(cwd, storiesPath, 'components')
    );
    addPreviewAnnotations(mainConfig, [`.${sep}${join(storiesPath, 'components')}`]);

    // Add stories for the renderer. NOTE: these *do* need to be processed by the framework build system
    await linkPackageStories(rendererPath, {
      mainConfig,
      cwd,
      linkInDir: resolve(cwd, storiesPath),
    });

    if (
      await pathExists(
        resolve(CODE_DIRECTORY, rendererPath, join('template', storiesVariantFolder))
      )
    ) {
      await linkPackageStories(
        rendererPath,
        {
          mainConfig,
          cwd,
          linkInDir: resolve(cwd, storiesPath),
        },
        sandboxSpecificStoriesFolder
      );
    }
  }

  const isCoreFramework = template.expected.framework.startsWith('@storybook/');

  if (isCoreFramework) {
    const frameworkPath = await workspacePath('frameworks', template.expected.framework);

    // Add stories for the framework if it has one. NOTE: these *do* need to be processed by the framework build system
    if (await pathExists(resolve(CODE_DIRECTORY, frameworkPath, join('template', 'stories')))) {
      await linkPackageStories(frameworkPath, {
        mainConfig,
        cwd,
        linkInDir: resolve(cwd, storiesPath),
      });
    }

    console.log({ sandboxSpecificStoriesFolder, storiesVariantFolder });

    if (
      await pathExists(
        resolve(CODE_DIRECTORY, frameworkPath, join('template', storiesVariantFolder))
      )
    ) {
      await linkPackageStories(
        frameworkPath,
        {
          mainConfig,
          cwd,
          linkInDir: resolve(cwd, storiesPath),
        },
        sandboxSpecificStoriesFolder
      );
    }
  }

  if (isCoreRenderer) {
    // Add stories for lib/store (and addons below). NOTE: these stories will be in the
    // template-stories folder and *not* processed by the framework build config (instead by esbuild-loader)
    await linkPackageStories(await workspacePath('core package', '@storybook/store'), {
      mainConfig,
      cwd,
    });
  }

  const mainAddons = (mainConfig.getSafeFieldValue(['addons']) || []).reduce(
    (acc: string[], addon: any) => {
      const name = typeof addon === 'string' ? addon : addon.name;
      const match = /@storybook\/addon-(.*)/.exec(name);
      if (!match) return acc;
      const suffix = match[1];
      if (suffix === 'essentials') {
        return [...acc, ...essentialsAddons];
      }
      return [...acc, suffix];
    },
    []
  );

  const addonDirs = await Promise.all(
    [...mainAddons, ...extraAddons].map(async (addon) =>
      workspacePath('addon', `@storybook/addon-${addon}`)
    )
  );

  if (isCoreRenderer) {
    const existingStories = await filterExistsInCodeDir(addonDirs, join('template', 'stories'));
    for (const packageDir of existingStories) {
      await linkPackageStories(packageDir, { mainConfig, cwd });
    }

    // Add some extra settings (see above for what these do)
    if (template.expected.builder === '@storybook/builder-webpack5') {
      addEsbuildLoaderToStories(mainConfig);
    }
  }

  // Some addon stories require extra dependencies
  await addExtraDependencies({ cwd, dryRun, debug });

  await writeConfig(mainConfig);
};

export const extendMain: Task['run'] = async ({ template, sandboxDir }) => {
  logger.log('📝 Extending main.js');
  const mainConfig = await readMainConfig({ cwd: sandboxDir });
  const templateConfig = template.modifications?.mainConfig || {};
  const configToAdd = {
    ...templateConfig,
    features: {
      ...templateConfig.features,
    },
  };

  Object.entries(configToAdd).forEach(([field, value]) => mainConfig.setFieldValue([field], value));

  if (template.expected.builder === '@storybook/builder-vite') setSandboxViteFinal(mainConfig);
  await writeConfig(mainConfig);
};

/**
 * Sets compodoc option in angular.json projects to false. We have to generate compodoc
 * manually to avoid symlink issues related to the template-stories folder.
 * In a second step a docs:json script is placed into the package.json to generate the
 * Compodoc documentation.json, which respects symlinks
 * */
async function prepareAngularSandbox(cwd: string) {
  const angularJson = await readJson(join(cwd, 'angular.json'));

  Object.keys(angularJson.projects).forEach((projectName: string) => {
    angularJson.projects[projectName].architect.storybook.options.compodoc = false;
    angularJson.projects[projectName].architect['build-storybook'].options.compodoc = false;
  });

  await writeJson(join(cwd, 'angular.json'), angularJson, { spaces: 2 });

  const packageJsonPath = join(cwd, 'package.json');
  const packageJson = await readJson(packageJsonPath);

  packageJson.scripts = {
    ...packageJson.scripts,
    'docs:json': 'DIR=$PWD; cd ../../scripts; yarn ts-node combine-compodoc $DIR',
    storybook: `yarn docs:json && ${packageJson.scripts.storybook}`,
    'build-storybook': `yarn docs:json && ${packageJson.scripts['build-storybook']}`,
  };

  await writeJson(packageJsonPath, packageJson, { spaces: 2 });
}
