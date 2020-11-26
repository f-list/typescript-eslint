import debug from 'debug';
import { sync as globSync } from 'globby';
import isGlob from 'is-glob';
import semver from 'semver';
import * as ts from 'typescript';
import { astConverter } from './ast-converter';
import { convertError } from './convert';
import { createDefaultProgram } from './create-program/createDefaultProgram';
import { createIsolatedProgram } from './create-program/createIsolatedProgram';
import { createProjectProgram } from './create-program/createProjectProgram';
import { Extra, TSESTreeOptions, ParserServices } from './parser-options';
import { getFirstSemanticOrSyntacticError } from './semantic-or-syntactic-errors';
import { TSESTree } from './ts-estree';
import { ASTAndProgram, ensureAbsolutePath } from './create-program/shared';
import { ParserOptions, Lib } from '@typescript-eslint/types';
import {
  analyze,
  AnalyzeOptions,
  ScopeManager,
} from '@typescript-eslint/scope-manager';
import { CompilerOptions, ScriptTarget } from 'typescript';
import { visitorKeys } from '@typescript-eslint/visitor-keys';

interface ParseForESLintResult {
  ast: TSESTree.Program & {
    range?: [number, number];
    tokens?: TSESTree.Token[];
    comments?: TSESTree.Comment[];
  };
  services: ParserServices;
  visitorKeys: typeof visitorKeys;
  scopeManager: ScopeManager;
}

function validateBoolean(
  value: boolean | undefined,
  fallback = false,
): boolean {
  if (typeof value !== 'boolean') {
    return fallback;
  }
  return value;
}

const LIB_FILENAME_REGEX = /lib\.(.+)\.d\.ts$/;
function getLib(compilerOptions: CompilerOptions): Lib[] {
  if (compilerOptions.lib) {
    return compilerOptions.lib.reduce((acc, lib) => {
      const match = LIB_FILENAME_REGEX.exec(lib.toLowerCase());
      if (match) {
        acc.push(match[1] as Lib);
      }

      return acc;
    }, [] as Lib[]);
  }

  const target = compilerOptions.target ?? ScriptTarget.ES5;
  // https://github.com/Microsoft/TypeScript/blob/59ad375234dc2efe38d8ee0ba58414474c1d5169/src/compiler/utilitiesPublic.ts#L13-L32
  switch (target) {
    case ScriptTarget.ESNext:
      return ['esnext.full'];
    case ScriptTarget.ES2020:
      return ['es2020.full'];
    case ScriptTarget.ES2019:
      return ['es2019.full'];
    case ScriptTarget.ES2018:
      return ['es2018.full'];
    case ScriptTarget.ES2017:
      return ['es2017.full'];
    case ScriptTarget.ES2016:
      return ['es2016.full'];
    case ScriptTarget.ES2015:
      return ['es6'];
    default:
      return ['lib'];
  }
}

function parse(
  code: string,
  options?: ParserOptions,
): ParseForESLintResult['ast'] {
  return parseForESLint(code, options).ast;
}

function parseForESLint(
  code: string,
  options?: ParserOptions | null,
): ParseForESLintResult {
  if (!options || typeof options !== 'object') {
    options = {};
  } else {
    options = { ...options };
  }
  // https://eslint.org/docs/user-guide/configuring#specifying-parser-options
  // if sourceType is not provided by default eslint expect that it will be set to "script"
  if (options.sourceType !== 'module' && options.sourceType !== 'script') {
    options.sourceType = 'script';
  }
  if (typeof options.ecmaFeatures !== 'object') {
    options.ecmaFeatures = {};
  }

  const parserOptions: TSESTreeOptions = {};
  Object.assign(parserOptions, options, {
    useJSXTextNode: validateBoolean(options.useJSXTextNode, true),
    jsx: validateBoolean(options.ecmaFeatures.jsx),
  });
  const analyzeOptions: AnalyzeOptions = {
    ecmaVersion: options.ecmaVersion,
    globalReturn: options.ecmaFeatures.globalReturn,
    jsxPragma: options.jsxPragma,
    jsxFragmentName: options.jsxFragmentName,
    lib: options.lib,
    sourceType: options.sourceType,
  };

  if (typeof options.filePath === 'string') {
    const tsx = options.filePath.endsWith('.tsx');
    if (tsx || options.filePath.endsWith('.ts')) {
      parserOptions.jsx = tsx;
    }
  }

  /**
   * Allow the user to suppress the warning from typescript-estree if they are using an unsupported
   * version of TypeScript
   */
  const warnOnUnsupportedTypeScriptVersion = validateBoolean(
    options.warnOnUnsupportedTypeScriptVersion,
    true,
  );
  if (!warnOnUnsupportedTypeScriptVersion) {
    parserOptions.loggerFn = false;
  }

  const { ast, services } = parseAndGenerateServices(code, parserOptions);
  ast.sourceType = options.sourceType;

  if (services.hasFullTypeInformation) {
    // automatically apply the options configured for the program
    const compilerOptions = services.program.getCompilerOptions();
    if (analyzeOptions.lib == null) {
      analyzeOptions.lib = getLib(compilerOptions);
      log('Resolved libs from program: %o', analyzeOptions.lib);
    }
    if (parserOptions.jsx === true) {
      if (
        analyzeOptions.jsxPragma === undefined &&
        compilerOptions.jsxFactory != null
      ) {
        // in case the user has specified something like "preact.h"
        const factory = compilerOptions.jsxFactory.split('.')[0].trim();
        analyzeOptions.jsxPragma = factory;
        log('Resolved jsxPragma from program: %s', analyzeOptions.jsxPragma);
      }
      if (
        analyzeOptions.jsxFragmentName === undefined &&
        compilerOptions.jsxFragmentFactory != null
      ) {
        // in case the user has specified something like "preact.Fragment"
        const fragFactory = compilerOptions.jsxFragmentFactory
          .split('.')[0]
          .trim();
        analyzeOptions.jsxFragmentName = fragFactory;
        log(
          'Resolved jsxFragmentName from program: %s',
          analyzeOptions.jsxFragmentName,
        );
      }
    }
  }

  const scopeManager = analyze(ast, analyzeOptions);

  return { ast, services, scopeManager, visitorKeys };
}

const log = debug('typescript-eslint:typescript-estree:parser');

/**
 * This needs to be kept in sync with the top-level README.md in the
 * typescript-eslint monorepo
 */
const SUPPORTED_TYPESCRIPT_VERSIONS = '>=3.3.1 <4.2.0';
/*
 * The semver package will ignore prerelease ranges, and we don't want to explicitly document every one
 * List them all separately here, so we can automatically create the full string
 */
const SUPPORTED_PRERELEASE_RANGES: string[] = ['4.1.1-rc', '4.1.0-beta'];
const ACTIVE_TYPESCRIPT_VERSION = ts.version;
const isRunningSupportedTypeScriptVersion = semver.satisfies(
  ACTIVE_TYPESCRIPT_VERSION,
  [SUPPORTED_TYPESCRIPT_VERSIONS]
    .concat(SUPPORTED_PRERELEASE_RANGES)
    .join(' || '),
);

let extra: Extra;
let warnedAboutTSVersion = false;

function enforceString(code: unknown): string {
  /**
   * Ensure the source code is a string
   */
  if (typeof code !== 'string') {
    return String(code);
  }

  return code;
}

/**
 * @param code The code of the file being linted
 * @param shouldProvideParserServices True if the program should be attempted to be calculated from provided tsconfig files
 * @param shouldCreateDefaultProgram True if the program should be created from compiler host
 * @returns Returns a source file and program corresponding to the linted code
 */
function getProgramAndAST(
  code: string,
  shouldProvideParserServices: boolean,
  shouldCreateDefaultProgram: boolean,
): ASTAndProgram {
  return (
    (shouldProvideParserServices &&
      createProjectProgram(code, shouldCreateDefaultProgram, extra)) ||
    (shouldProvideParserServices &&
      shouldCreateDefaultProgram &&
      createDefaultProgram(code, extra)) ||
    createIsolatedProgram(code, extra)
  );
}

/**
 * Compute the filename based on the parser options.
 *
 * Even if jsx option is set in typescript compiler, filename still has to
 * contain .tsx file extension.
 *
 * @param options Parser options
 */
function getFileName({ jsx }: { jsx?: boolean } = {}): string {
  return jsx ? 'estree.tsx' : 'estree.ts';
}

/**
 * Resets the extra config object
 */
function resetExtra(): void {
  extra = {
    code: '',
    comment: false,
    comments: [],
    createDefaultProgram: false,
    debugLevel: new Set(),
    errorOnTypeScriptSyntacticAndSemanticIssues: false,
    errorOnUnknownASTType: false,
    EXPERIMENTAL_useSourceOfProjectReferenceRedirect: false,
    extraFileExtensions: [],
    filePath: getFileName(),
    jsx: false,
    loc: false,
    log: console.log, // eslint-disable-line no-console
    preserveNodeMaps: true,
    projects: [],
    range: false,
    strict: false,
    tokens: null,
    tsconfigRootDir: process.cwd(),
    useJSXTextNode: false,
  };
}

/**
 * Normalizes, sanitizes, resolves and filters the provided
 */
function prepareAndTransformProjects(
  projectsInput: string | string[] | undefined,
  ignoreListInput: string[],
): string[] {
  let projects: string[] = [];

  // Normalize and sanitize the project paths
  if (typeof projectsInput === 'string') {
    projects.push(projectsInput);
  } else if (Array.isArray(projectsInput)) {
    for (const project of projectsInput) {
      if (typeof project === 'string') {
        projects.push(project);
      }
    }
  }

  if (projects.length === 0) {
    return projects;
  }

  // Transform glob patterns into paths
  const globbedProjects = projects.filter(project => isGlob(project));
  projects = projects
    .filter(project => !isGlob(project))
    .concat(
      globSync([...globbedProjects, ...ignoreListInput], {
        cwd: extra.tsconfigRootDir,
      }),
    );

  log(
    'parserOptions.project (excluding ignored) matched projects: %s',
    projects,
  );

  return projects;
}

function applyParserOptionsToExtra(options: TSESTreeOptions): void {
  /**
   * Configure Debug logging
   */
  if (options.debugLevel === true) {
    extra.debugLevel = new Set(['typescript-eslint']);
  } else if (Array.isArray(options.debugLevel)) {
    extra.debugLevel = new Set(options.debugLevel);
  }
  if (extra.debugLevel.size > 0) {
    // debug doesn't support multiple `enable` calls, so have to do it all at once
    const namespaces = [];
    if (extra.debugLevel.has('typescript-eslint')) {
      namespaces.push('typescript-eslint:*');
    }
    if (
      extra.debugLevel.has('eslint') ||
      // make sure we don't turn off the eslint debug if it was enabled via --debug
      debug.enabled('eslint:*,-eslint:code-path')
    ) {
      // https://github.com/eslint/eslint/blob/9dfc8501fb1956c90dc11e6377b4cb38a6bea65d/bin/eslint.js#L25
      namespaces.push('eslint:*,-eslint:code-path');
    }
    debug.enable(namespaces.join(','));
  }

  /**
   * Track range information in the AST
   */
  extra.range = typeof options.range === 'boolean' && options.range;
  extra.loc = typeof options.loc === 'boolean' && options.loc;

  /**
   * Track tokens in the AST
   */
  if (typeof options.tokens === 'boolean' && options.tokens) {
    extra.tokens = [];
  }

  /**
   * Track comments in the AST
   */
  if (typeof options.comment === 'boolean' && options.comment) {
    extra.comment = true;
    extra.comments = [];
  }

  /**
   * Enable JSX - note the applicable file extension is still required
   */
  if (typeof options.jsx === 'boolean' && options.jsx) {
    extra.jsx = true;
  }

  /**
   * Get the file path
   */
  if (typeof options.filePath === 'string' && options.filePath !== '<input>') {
    extra.filePath = options.filePath;
  } else {
    extra.filePath = getFileName(extra);
  }

  /**
   * The JSX AST changed the node type for string literals
   * inside a JSX Element from `Literal` to `JSXText`.
   *
   * When value is `true`, these nodes will be parsed as type `JSXText`.
   * When value is `false`, these nodes will be parsed as type `Literal`.
   */
  if (typeof options.useJSXTextNode === 'boolean' && options.useJSXTextNode) {
    extra.useJSXTextNode = true;
  }

  /**
   * Allow the user to cause the parser to error if it encounters an unknown AST Node Type
   * (used in testing)
   */
  if (
    typeof options.errorOnUnknownASTType === 'boolean' &&
    options.errorOnUnknownASTType
  ) {
    extra.errorOnUnknownASTType = true;
  }

  /**
   * Allow the user to override the function used for logging
   */
  if (typeof options.loggerFn === 'function') {
    extra.log = options.loggerFn;
  } else if (options.loggerFn === false) {
    extra.log = (): void => {};
  }

  if (typeof options.tsconfigRootDir === 'string') {
    extra.tsconfigRootDir = options.tsconfigRootDir;
  }

  // NOTE - ensureAbsolutePath relies upon having the correct tsconfigRootDir in extra
  extra.filePath = ensureAbsolutePath(extra.filePath, extra);
  if (extra.filePath.endsWith('.vue')) extra.filePath += '.ts';

  // NOTE - prepareAndTransformProjects relies upon having the correct tsconfigRootDir in extra
  const projectFolderIgnoreList = (options.projectFolderIgnoreList ?? [])
    .reduce<string[]>((acc, folder) => {
      if (typeof folder === 'string') {
        acc.push(folder);
      }
      return acc;
    }, [])
    // prefix with a ! for not match glob
    .map(folder => (folder.startsWith('!') ? folder : `!${folder}`));
  extra.projects = prepareAndTransformProjects(
    options.project,
    projectFolderIgnoreList,
  );

  if (
    Array.isArray(options.extraFileExtensions) &&
    options.extraFileExtensions.every(ext => typeof ext === 'string')
  ) {
    extra.extraFileExtensions = options.extraFileExtensions;
  }

  /**
   * Allow the user to enable or disable the preservation of the AST node maps
   * during the conversion process.
   */
  if (typeof options.preserveNodeMaps === 'boolean') {
    extra.preserveNodeMaps = options.preserveNodeMaps;
  }

  extra.createDefaultProgram =
    typeof options.createDefaultProgram === 'boolean' &&
    options.createDefaultProgram;

  extra.EXPERIMENTAL_useSourceOfProjectReferenceRedirect =
    typeof options.EXPERIMENTAL_useSourceOfProjectReferenceRedirect ===
      'boolean' && options.EXPERIMENTAL_useSourceOfProjectReferenceRedirect;
}

function warnAboutTSVersion(): void {
  if (!isRunningSupportedTypeScriptVersion && !warnedAboutTSVersion) {
    const isTTY = typeof process === undefined ? false : process.stdout?.isTTY;
    if (isTTY) {
      const border = '=============';
      const versionWarning = [
        border,
        'WARNING: You are currently running a version of TypeScript which is not officially supported by @typescript-eslint/typescript-estree.',
        'You may find that it works just fine, or you may not.',
        `SUPPORTED TYPESCRIPT VERSIONS: ${SUPPORTED_TYPESCRIPT_VERSIONS}`,
        `YOUR TYPESCRIPT VERSION: ${ACTIVE_TYPESCRIPT_VERSION}`,
        'Please only submit bug reports when using the officially supported version.',
        border,
      ];
      extra.log(versionWarning.join('\n\n'));
    }
    warnedAboutTSVersion = true;
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface EmptyObject {}
type AST<T extends TSESTreeOptions> = TSESTree.Program &
  (T['tokens'] extends true ? { tokens: TSESTree.Token[] } : EmptyObject) &
  (T['comment'] extends true ? { comments: TSESTree.Comment[] } : EmptyObject);

interface ParseAndGenerateServicesResult<T extends TSESTreeOptions> {
  ast: AST<T>;
  services: ParserServices;
}

function parseAndGenerateServices<T extends TSESTreeOptions = TSESTreeOptions>(
  code: string,
  options: T,
): ParseAndGenerateServicesResult<T> {
  /**
   * Reset the parse configuration
   */
  resetExtra();

  /**
   * Ensure the source code is a string, and store a reference to it
   */
  code = enforceString(code);
  extra.code = code;

  /**
   * Apply the given parser options
   */
  if (typeof options !== 'undefined') {
    applyParserOptionsToExtra(options);
    if (
      typeof options.errorOnTypeScriptSyntacticAndSemanticIssues ===
        'boolean' &&
      options.errorOnTypeScriptSyntacticAndSemanticIssues
    ) {
      extra.errorOnTypeScriptSyntacticAndSemanticIssues = true;
    }
  }

  /**
   * Warn if the user is using an unsupported version of TypeScript
   */
  warnAboutTSVersion();

  /**
   * Generate a full ts.Program in order to be able to provide parser
   * services, such as type-checking
   */
  const shouldProvideParserServices =
    extra.projects && extra.projects.length > 0;
  const { ast, program } = getProgramAndAST(
    code,
    shouldProvideParserServices,
    extra.createDefaultProgram,
  )!;

  /**
   * Convert the TypeScript AST to an ESTree-compatible one, and optionally preserve
   * mappings between converted and original AST nodes
   */
  const preserveNodeMaps =
    typeof extra.preserveNodeMaps === 'boolean' ? extra.preserveNodeMaps : true;
  const { estree, astMaps } = astConverter(ast, extra, preserveNodeMaps);

  /**
   * Even if TypeScript parsed the source code ok, and we had no problems converting the AST,
   * there may be other syntactic or semantic issues in the code that we can optionally report on.
   */
  if (program && extra.errorOnTypeScriptSyntacticAndSemanticIssues) {
    const error = getFirstSemanticOrSyntacticError(program, ast);
    if (error) {
      throw convertError(error);
    }
  }

  /**
   * Return the converted AST and additional parser services
   */
  return {
    ast: estree as AST<T>,
    services: {
      hasFullTypeInformation: shouldProvideParserServices,
      program,
      esTreeNodeToTSNodeMap: astMaps.esTreeNodeToTSNodeMap,
      tsNodeToESTreeNodeMap: astMaps.tsNodeToESTreeNodeMap,
    },
  };
}

export { parse, parseForESLint, ParserOptions };
