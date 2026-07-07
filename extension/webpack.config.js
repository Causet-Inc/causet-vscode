//@ts-check
'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist/extension'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: { '.js': ['.js', '.ts'] },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }],
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: { level: 'log' },
};

/** @type {import('webpack').Configuration} */
const serverConfig = {
  target: 'node',
  mode: 'none',
  entry: '../language-server/src/server.ts',
  output: {
    path: path.resolve(__dirname, 'dist/server'),
    filename: 'server.js',
    libraryTarget: 'commonjs2',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: { '.js': ['.js', '.ts'] },
    alias: {
      'causet-shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader', options: { configFile: path.resolve(__dirname, '../language-server/tsconfig.webpack.json'), transpileOnly: true } }],
      },
    ],
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  devtool: 'nosources-source-map',
};

/** @type {import('webpack').Configuration} */
const copyConfig = {
  entry: './src/extension.ts', // dummy entry just to trigger the copy plugin
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'syntaxes', to: '../syntaxes' },
        { from: 'snippets', to: '../snippets' },
        { from: 'themes', to: '../themes' },
        { from: 'icons', to: '../icons' },
        { from: 'language-configuration.json', to: '../language-configuration.json' },
      ],
    }),
  ],
  output: { path: path.resolve(__dirname, 'dist/extension'), filename: '_copy.js' },
};

module.exports = [extensionConfig, serverConfig];
