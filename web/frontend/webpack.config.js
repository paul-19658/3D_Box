const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const { VueLoaderPlugin } = require('vue-loader')

/**
 * 前端构建配置。
 *
 * 选择 webpack 而非 Vite 的原因：本项目锁定 vue-template-compiler 2.6.14，
 * Vue 2.6 的模板编译依赖 vue-loader 15，它与 webpack 5 的集成最成熟；
 * Vite 需要额外的 vite-plugin-vue2，且与 vue-template-compiler 的版本
 * 对齐更脆弱。团队协作场景下优先选择确定性更高的组合。
 */
module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production'

  return {
    entry: path.resolve(__dirname, 'src/main.js'),
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProduction ? 'assets/[name].[contenthash:8].js' : 'assets/[name].js',
      chunkFilename: isProduction ? 'assets/[name].[contenthash:8].js' : 'assets/[name].js',
      publicPath: '/',
      clean: true
    },
    resolve: {
      extensions: ['.js', '.vue', '.json'],
      alias: {
        vue$: 'vue/dist/vue.runtime.esm.js',
        '@': path.resolve(__dirname, 'src')
      }
    },
    module: {
      rules: [
        {
          test: /\.vue$/,
          loader: 'vue-loader'
        },
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [['@babel/preset-env', { targets: { chrome: '110' } }]]
            }
          }
        },
        {
          test: /\.css$/,
          use: [isProduction ? MiniCssExtractPlugin.loader : 'vue-style-loader', 'css-loader']
        },
        {
          // three.js 的部分 addon 与 glTF 示例会引用图片资源，统一交给 asset 模块处理。
          test: /\.(png|jpe?g|gif|svg|glb|gltf)$/,
          type: 'asset/resource',
          generator: { filename: 'assets/[name].[hash:8][ext]' }
        }
      ]
    },
    plugins: [
      new VueLoaderPlugin(),
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, 'public/index.html'),
        favicon: undefined,
        minify: isProduction
      }),
      /*
       * 把 public/ 里的静态文件原样复制到 dist/。
       *
       * 目前只用于人台骨骼模型（mannequin/*.glb）。它必须以普通文件形式
       * 存在，不能走 asset/resource 打进 JS 依赖图——否则 vitest
       * 会在解析 .glb 时直接报"invalid JS syntax"，把纯逻辑测试全拖垮。
       *
       * 用 copyPatterns 的 globOptions 排除 index.html：
       * 那是 HtmlWebpackPlugin 的模板，复制到 dist 会造成两份来源。
       */
      new CopyWebpackPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, 'public'),
            to: path.resolve(__dirname, 'dist'),
            globOptions: { ignore: ['**/index.html'] },
            noErrorOnMissing: true
          }
        ]
      }),
      ...(isProduction
        ? [new MiniCssExtractPlugin({ filename: 'assets/[name].[contenthash:8].css' })]
        : [])
    ],
    devServer: {
      // 允许通过 DEV_SERVER_PORT 覆盖端口：多人并行开发时容易撞 8080。
      port: Number(process.env.DEV_SERVER_PORT) || 8080,
      historyApiFallback: true,
      hot: true,
      client: { overlay: { errors: true, warnings: false } },
      proxy: [
        {
          // 前端只调用 /api，开发期由 dev-server 转发到 FastAPI，避免跨域配置分散。
          context: ['/api'],
          target: 'http://127.0.0.1:8000',
          changeOrigin: true
        }
      ]
    },
    devtool: isProduction ? 'source-map' : 'eval-cheap-module-source-map',
    performance: {
      /*
       * three.js 与导入导出模块体积较大，给出明确上限而非静默忽略。
       *
       * maxAssetSize 放到 8MB 是为了人台骨骼模型
       * （quaternius-ual1-standard.glb，约 7.3MB）：
       * 它含 5 个动作片段与完整蒙皮，是独立资源、不参与首屏打包，
       * 只有场景里真的放了人台才会被请求，因此不影响加载性能。
       * 调低这个值只会让每次构建都刷一条无意义的警告。
       */
      maxEntrypointSize: 4_000_000,
      maxAssetSize: 8_000_000
    }
  }
}
