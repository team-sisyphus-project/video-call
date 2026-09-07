/* global __dirname */

const CircularDependencyPlugin = require('circular-dependency-plugin');
const fs = require('fs');
const { join, resolve } = require('path');
const process = require('process');
const webpack = require('webpack');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');

/**
 * The URL of the Jitsi Meet deployment to be proxy to in the context of
 * development with webpack-dev-server.
 */
const devServerProxyTarget
    = process.env.WEBPACK_DEV_SERVER_PROXY_TARGET || 'https://alpha.jitsi.net';

/**
 * Demo mode serves the application shell (index.html, config.js,
 * interface_config.js) from this checkout instead of pulling it from the proxy
 * target. Signalling is still proxied, so a reachable backend gives real
 * meetings while an unreachable one still leaves the whole pre-conference UI
 * browsable. Enabled by `make demo`.
 */
const isDemoMode = Boolean(process.env.MEETSPACE_DEMO);

/**
 * Build a Performance configuration object for the given size.
 * See: https://webpack.js.org/configuration/performance/
 *
 * @param {Object} options - options for the bundles configuration.
 * @param {boolean} options.analyzeBundle - whether the bundle needs to be analyzed for size.
 * @param {boolean} options.isProduction - whether this is a production build or not.
 * @param {number} size - the size limit to apply.
 * @returns {Object} a performance hints object.
 */
function getPerformanceHints(options, size) {
    const { analyzeBundle, isProduction } = options;

    return {
        hints: isProduction && !analyzeBundle ? 'error' : false,
        maxAssetSize: size,
        maxEntrypointSize: size
    };
}

/**
 * Build a BundleAnalyzerPlugin plugin instance for the given bundle name.
 *
 * @param {boolean} analyzeBundle - whether the bundle needs to be analyzed for size.
 * @param {string} name - the name of the bundle.
 * @returns {Array} a configured list of plugins.
 */
function getBundleAnalyzerPlugin(analyzeBundle, name) {
    if (!analyzeBundle) {
        return [];
    }

    return [ new BundleAnalyzerPlugin({
        analyzerMode: 'disabled',
        generateStatsFile: true,
        statsFilename: `${name}-stats.json`
    }) ];
}

/**
 * Serves the locally generated application shell for demo mode.
 *
 * Anything that looks like a room URL (`/`, `/StandupDemo`, `/tenant/room`) is
 * answered with `index.demo.html`. Assets and signalling endpoints fall through
 * to the regular dev server and proxy handling.
 *
 * @param {Object} req - The (HTTP) request.
 * @param {Object} res - The (HTTP) response.
 * @param {Function} next - Passes the request on to the next middleware.
 * @returns {void}
 */
function demoShellMiddleware(req, res, next) {
    const path = (req.url || '/').split('?')[0];
    const isAsset = /\.[a-z0-9]+$/i.test(path)
        || /^\/(css|doc|fonts|images|lang|libs|sounds|static|demo|ws|__webpack)\b/.test(path)
        || path.startsWith('/http-bind')
        || path.startsWith('/xmpp-websocket')
        || path.startsWith('/colibri-ws');

    if (req.method !== 'GET' || isAsset) {
        return next();
    }

    const shell = join(process.cwd(), 'index.demo.html');

    if (!fs.existsSync(shell)) {
        res.statusCode = 500;

        return res.end('index.demo.html is missing. Run `make demo`.');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    return res.end(fs.readFileSync(shell));
}

/**
 * Determines whether a specific (HTTP) request is to bypass the proxy of
 * webpack-dev-server (i.e. is to be handled by the proxy target) and, if not,
 * which local file is to be served in response to the request.
 *
 * @param {Object} request - The (HTTP) request received by the proxy.
 * @returns {string|undefined} If the request is to be served by the proxy
 * target, undefined; otherwise, the path to the local file to be served.
 */
function devServerProxyBypass({ path }) {
    let tpath = path;

    if (tpath.startsWith('/v1/_cdn/')) {
        // The CDN is not available in the dev server, so we need to bypass it.
        tpath = tpath.replace(/\/v1\/_cdn\/[^/]+\//, '/');
    }

    // A page opened from a tenant meeting URL asks for its static assets under
    // that tenant (e.g. /tenant/static/secondScreen.html), which would otherwise
    // be proxied to the dev target and serve that deployment's copy, or a 404 for
    // a file that only exists locally.
    tpath = tpath.replace(/^\/[^/]+\/static\//, '/static/');

    if (tpath.startsWith('/css/')
            // Demo mode serves its config files from this checkout.
            || tpath.startsWith('/demo/')
            || tpath.startsWith('/doc/')
            || tpath.startsWith('/fonts/')
            || tpath.startsWith('/images/')
            || tpath.startsWith('/lang/')
            || tpath.startsWith('/sounds/')
            || tpath.startsWith('/static/')
            || tpath.endsWith('.wasm')) {

        return tpath;
    }

    if (tpath.startsWith('/libs/')) {
        if (tpath.endsWith('.min.js') && !fs.existsSync(join(process.cwd(), tpath))) {
            return tpath.replace('.min.js', '.js');
        }

        return tpath;
    }
}

/**
 * The base Webpack configuration to bundle the JavaScript artifacts of
 * jitsi-meet such as app.bundle.js and external_api.js.
 *
 * @param {Object} options - options for the bundles configuration.
 * @param {boolean} options.detectCircularDeps - whether to detect circular dependencies or not.
 * @param {boolean} options.isProduction - whether this is a production build or not.
 * @returns {Object} the base config object.
 */
function getConfig(options = {}) {
    const { detectCircularDeps, isProduction } = options;

    return {
        devtool: isProduction ? 'source-map' : 'eval-source-map',
        mode: isProduction ? 'production' : 'development',
        module: {
            rules: [ {
                // Transpile ES2015 (aka ES6) to ES5. Accept the JSX syntax by React
                // as well.

                loader: 'babel-loader',
                options: {
                    // Avoid loading babel.config.js, since we only use it for React Native.
                    configFile: false,

                    presets: [
                        [
                            require.resolve('@babel/preset-env'),

                            // Tell babel to avoid compiling imports into CommonJS
                            // so that webpack may do tree shaking.
                            {
                                modules: false,

                                // Specify our target browsers so no transpiling is
                                // done unnecessarily. For browsers not specified
                                // here, the ES2015+ profile will be used.
                                targets: {
                                    chrome: 80,
                                    electron: 10,
                                    firefox: 68,
                                    safari: 14
                                },

                                // Consider stage 3 proposals which are implemented by some browsers already.
                                shippedProposals: true,

                                // Detect usage of modern JavaScript features and automatically polyfill them
                                // with core-js.
                                useBuiltIns: 'usage',

                                // core-js version to use, must be in sync with the version in package.json.
                                corejs: '3.40'
                            }
                        ],
                        require.resolve('@babel/preset-react')
                    ]
                },
                test: /\.(j|t)sx?$/,
                exclude: /node_modules/
            }, {
                // Emit woff2 fonts to excalidraw/fonts/ preserving the subdirectory
                // structure so they land at the same path that deploy-excalidraw copies
                // them to (libs/excalidraw/fonts/...) and CSS @font-face URLs resolve.
                test: /\.woff2$/,
                type: 'asset/resource',
                generator: {
                    filename: pathData => {
                        const match = pathData.filename?.match(/\/fonts\/(.*)/);

                        return match ? `excalidraw/fonts/${match[1]}` : 'excalidraw/fonts/[name][ext]';
                    }
                }
            }, {
                // Allow CSS to be imported into JavaScript.

                test: /\.css$/,
                use: [
                    'style-loader',
                    'css-loader'
                ]
            }, {
                // Import SVG as raw text when using ?raw query parameter.
                test: /\.svg$/,
                resourceQuery: /raw/,
                type: 'asset/source'
            }, {
                // Import SVG as React component (default).
                test: /\.svg$/,
                resourceQuery: { not: [ /raw/ ] },
                use: [ {
                    loader: '@svgr/webpack',
                    options: {
                        dimensions: false,
                        expandProps: 'start'
                    }
                } ]
            }, {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                loader: 'ts-loader',
                options: {
                    configFile: 'tsconfig.web.json',
                    transpileOnly: !isProduction // Skip type checking for dev builds.,
                }
            } ]
        },
        node: {
            // Allow the use of the real filename of the module being executed. By
            // default Webpack does not leak path-related information and provides a
            // value that is a mock (/index.js).
            __filename: true
        },
        optimization: {
            concatenateModules: isProduction,
            minimize: isProduction
        },
        output: {
            filename: `[name]${isProduction ? '.min' : ''}.js`,
            chunkFilename: `chunks/[id]${isProduction ? '.min' : ''}.js`,
            path: `${__dirname}/build`,
            publicPath: isProduction ? 'auto' : '/libs/',
            sourceMapFilename: '[file].map'
        },
        plugins: [
            detectCircularDeps
                && new CircularDependencyPlugin({
                    allowAsyncCycles: false,
                    exclude: /node_modules/,
                    failOnError: false
                })
        ].filter(Boolean),
        resolve: {
            alias: {
                'focus-visible': 'focus-visible/dist/focus-visible.min.js',
                '@giphy/js-analytics': resolve(__dirname, 'giphy-analytics-stub.js'),
                'react': resolve(__dirname, 'node_modules/react'),
                'react-dom': resolve(__dirname, 'node_modules/react-dom'),
                'roughjs/bin/rough': 'roughjs/bin/rough.js',
                'roughjs/bin/generator': 'roughjs/bin/generator.js',
                'roughjs/bin/math': 'roughjs/bin/math.js'
            },
            aliasFields: [
                'browser'
            ],
            extensions: [
                '.web.js',
                '.web.ts',
                '.web.tsx',

                // Typescript:
                '.tsx',
                '.ts',

                // Webpack defaults:
                '.js',
                '.json'
            ],
            fallback: {
                // Provide some empty Node modules (required by AtlasKit, olm).
                crypto: false,
                fs: false,
                path: false,
                process: false
            }
        }
    };
}

/**
 * Helper function to build the dev server config. It's necessary to split it in
 * Webpack 5 because only one devServer entry is supported, so we attach it to
 * the main bundle.
 *

 * @returns {Object} the dev server configuration.
 */
function getDevServerConfig() {
    return {
        client: {
            overlay: {
                errors: true,
                warnings: false
            },

            // Behind the demo launcher's proxy the browser must open the HMR
            // socket back through whatever host and port it loaded the page
            // from, not through the dev server's own bind address.
            webSocketURL: isDemoMode ? 'auto://0.0.0.0:0/ws' : undefined
        },
        allowedHosts: 'all',

        // A preview harness assigns the port and needs the server reachable on
        // every interface, not just the IPv6 loopback that 'localhost' resolves
        // to. Upstream behaviour is unchanged when the vars are unset.
        host: process.env.MEETSPACE_HOST || 'localhost',
        port: process.env.MEETSPACE_PORT
            ? Number(process.env.MEETSPACE_PORT)
            : 8080,
        hot: true,
        proxy: [
            {
                context: [ '/' ],
                bypass: devServerProxyBypass,
                secure: false,
                target: devServerProxyTarget,
                headers: {
                    'Host': new URL(devServerProxyTarget).host
                }
            }
        ],
        // Demo mode defaults to plain HTTP so there is no self signed
        // certificate warning to click through. http://localhost is still a
        // secure context, so camera and microphone access works. Set
        // MEETSPACE_HTTPS=1 to serve over HTTPS instead.
        server: process.env.CODESPACES || (isDemoMode && !process.env.MEETSPACE_HTTPS)
            ? 'http'
            : 'https',
        setupMiddlewares: (middlewares, _devServer) => {
            const filtered = middlewares.filter(
                m => m.name !== 'cross-origin-header-check'
            );

            if (isDemoMode) {
                filtered.unshift({
                    name: 'meetspace-demo-shell',
                    middleware: demoShellMiddleware
                });
            }

            return filtered;
        },
        static: {
            directory: process.cwd(),
            watch: {
                ignored: file => file.endsWith('.log') || file.includes('node_modules')
            }
        }
    };
}

module.exports = (_env, argv) => {
    const analyzeBundle = Boolean(process.env.ANALYZE_BUNDLE);
    const mode = typeof argv.mode === 'undefined' ? 'production' : argv.mode;
    const isProduction = mode === 'production';
    const configOptions = {
        detectCircularDeps: Boolean(process.env.DETECT_CIRCULAR_DEPS),
        isProduction
    };
    const config = getConfig(configOptions);
    const perfHintOptions = {
        analyzeBundle,
        isProduction
    };

    return [
        { ...config,
            entry: {
                'app.bundle': './app.js'
            },
            devServer: isProduction ? {} : getDevServerConfig(),
            plugins: [
                ...config.plugins,
                ...getBundleAnalyzerPlugin(analyzeBundle, 'app'),
                new webpack.DefinePlugin({
                    '__DEV__': !isProduction
                }),
                new webpack.IgnorePlugin({
                    resourceRegExp: /^canvas$/,
                    contextRegExp: /resemblejs$/
                }),
                new webpack.IgnorePlugin({
                    resourceRegExp: /^\.\/locale$/,
                    contextRegExp: /moment$/
                }),
                new webpack.ProvidePlugin({
                    process: 'process/browser'
                })
            ],

            performance: getPerformanceHints(perfHintOptions, 3.5 * 1024 * 1024) },
        { ...config,
            entry: {
                'alwaysontop': './react/features/always-on-top/index.tsx'
            },
            plugins: [
                ...config.plugins,
                ...getBundleAnalyzerPlugin(analyzeBundle, 'alwaysontop')
            ],
            performance: getPerformanceHints(perfHintOptions, 800 * 1024) },
        { ...config,
            entry: {
                'documentpip': './react/features/always-on-top/document-pip-index.tsx'
            },
            plugins: [
                ...config.plugins,
                ...getBundleAnalyzerPlugin(analyzeBundle, 'documentpip')
            ],
            performance: getPerformanceHints(perfHintOptions, 800 * 1024) },
        { ...config,
            entry: {
                'close3': './static/close3.js'
            },
            plugins: [
                ...config.plugins,
                ...getBundleAnalyzerPlugin(analyzeBundle, 'close3')
            ],
            performance: getPerformanceHints(perfHintOptions, 128 * 1024) },

        { ...config,
            entry: {
                'external_api': './modules/API/external/index.js'
            },
            output: { ...config.output,
                library: 'JitsiMeetExternalAPI',
                libraryTarget: 'umd' },
            plugins: [
                ...config.plugins,
                ...getBundleAnalyzerPlugin(analyzeBundle, 'external_api')
            ],
            performance: getPerformanceHints(perfHintOptions, 100 * 1024) },
        { ...config,
            entry: {
                'face-landmarks-worker': './react/features/face-landmarks/faceLandmarksWorker.ts'
            },
            plugins: [
                ...config.plugins,
                ...getBundleAnalyzerPlugin(analyzeBundle, 'face-landmarks-worker')
            ],
            performance: getPerformanceHints(perfHintOptions, 1024 * 1024 * 2) },
        { ...config,
            entry: {
                'vb-inference-worker':
                    './react/features/stream-effects/virtual-background/workers/VBInferenceWorker.ts'
            },
            plugins: [
                ...config.plugins,
                ...getBundleAnalyzerPlugin(analyzeBundle, 'vb-inference-worker')
            ],
            performance: getPerformanceHints(perfHintOptions, 1024 * 1024 * 2) },
        { ...config, /**
             * The NoiseSuppressorWorklet is loaded in an audio worklet which doesn't have the same
             * context as a normal window, (e.g. self/window is not defined).
             * While running a production build webpack's boilerplate code doesn't introduce any
             * audio worklet "unfriendly" code however when running the dev server, hot module replacement
             * and live reload add javascript code that can't be ran by the worklet, so we explicitly ignore
             * those parts with the null-loader.
             * The dev server also expects a `self` global object that's not available in the `AudioWorkletGlobalScope`,
             * so we replace it.
             */
            entry: {
                'noise-suppressor-worklet':
                    './react/features/stream-effects/noise-suppression/NoiseSuppressorWorklet.ts'
            },

            module: { rules: [
                ...config.module.rules,
                {
                    test: resolve(__dirname, 'node_modules/webpack-dev-server/client'),
                    loader: 'null-loader'
                }
            ] },
            plugins: [
            ],
            performance: getPerformanceHints(perfHintOptions, 1024 * 1024 * 2),

            output: {
                ...config.output,

                globalObject: 'AudioWorkletGlobalScope'
            } },

        { ...config,
            entry: {
                'screenshot-capture-worker': './react/features/screenshot-capture/worker.ts'
            },
            plugins: [
                ...config.plugins,
                ...getBundleAnalyzerPlugin(analyzeBundle, 'screenshot-capture-worker')
            ],
            performance: getPerformanceHints(perfHintOptions, 30 * 1024) }
    ];
};
