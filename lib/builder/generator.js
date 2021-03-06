import fs from 'fs'
import { copy, remove, writeFile, mkdirp } from 'fs-extra'
import _ from 'lodash'
import { resolve, join, dirname, sep } from 'path'
import { minify } from 'html-minifier'
import Tapable from 'tappable'
import { isUrl, promisifyRoute, waitFor, flatRoutes } from 'utils'
import Debug from 'debug'

const debug = Debug('nuxt:generate')

export default class Generator extends Tapable {
  constructor (nuxt, builder) {
    super()
    this.nuxt = nuxt
    this.options = nuxt.options
    this.builder = builder
  }

  async generate (doBuild = true) {
    const s = Date.now()
    let errors = []
    let generateRoutes = []

    // Set variables
    let srcStaticPath = resolve(this.options.srcDir, 'static')
    let srcBuiltPath = resolve(this.options.buildDir, 'dist')
    let distPath = resolve(this.options.rootDir, this.options.generate.dir)
    let distNuxtPath = join(distPath, (isUrl(this.options.build.publicPath) ? '' : this.options.build.publicPath))

    // Wait for nuxt be ready
    await this.nuxt.ready()

    // Start build process
    if (this.builder && doBuild) {
      await this.builder.build()
    }

    // Clean destination folder
    await remove(distPath)
    debug('Destination folder cleaned')

    // Copy static and built files
    /* istanbul ignore if */
    if (fs.existsSync(srcStaticPath)) {
      await copy(srcStaticPath, distPath)
    }
    await copy(srcBuiltPath, distNuxtPath)
    debug('Static & build files copied')

    // Resolve config.generate.routes promises before generating the routes
    if (this.options.router.mode !== 'hash') {
      try {
        console.log('Generating routes') // eslint-disable-line no-console
        generateRoutes = await promisifyRoute(this.options.generate.routes || [])
      } catch (e) {
        console.error('Could not resolve routes') // eslint-disable-line no-console
        console.error(e) // eslint-disable-line no-console
        throw e // eslint-disable-line no-unreachable
      }
    }

    const decorateWithPayloads = (routes) => {
      let routeMap = {}
      // Fill routeMap for known routes
      routes.forEach((route) => {
        routeMap[route] = {
          route,
          payload: null
        }
      })
      // Fill routeMap with given generate.routes
      generateRoutes.forEach((route) => {
        // route is either a string or like {route : "/my_route/1"}
        const path = _.isString(route) ? route : route.route
        routeMap[path] = {
          route: path,
          payload: route.payload || null
        }
      })
      return _.values(routeMap)
    }

    // Generate only index.html for router.mode = 'hash'
    let routes = (this.options.router.mode === 'hash') ? ['/'] : flatRoutes(this.options.router.routes)
    routes = decorateWithPayloads(routes)

    while (routes.length) {
      let n = 0
      await Promise.all(routes.splice(0, 500).map(async ({ route, payload }) => {
        await waitFor(n++ * this.options.generate.interval)
        let html
        try {
          const res = await this.nuxt.renderer.renderRoute(route, { _generate: true, payload })
          html = res.html
          if (res.error) {
            errors.push({ type: 'handled', route, error: res.error })
          }
        } catch (err) {
          /* istanbul ignore next */
          return errors.push({ type: 'unhandled', route, error: err })
        }
        if (this.options.generate.minify) {
          try {
            html = minify(html, this.options.generate.minify)
          } catch (err) /* istanbul ignore next */ {
            const minifyErr = new Error(`HTML minification failed. Make sure the route generates valid HTML. Failed HTML:\n ${html}`)
            errors.push({ type: 'unhandled', route, error: minifyErr })
          }
        }
        let path = join(route, sep, 'index.html') // /about -> /about/index.html
        debug('Generate file: ' + path)
        path = join(distPath, path)
        // Make sure the sub folders are created
        await mkdirp(dirname(path))
        await writeFile(path, html, 'utf8')
      }))
    }

    // Add .nojekyll file to let Github Pages add the _nuxt/ folder
    // https://help.github.com/articles/files-that-start-with-an-underscore-are-missing/
    const nojekyllPath = resolve(distPath, '.nojekyll')
    writeFile(nojekyllPath, '')
    const duration = Math.round((Date.now() - s) / 100) / 10
    debug(`HTML Files generated in ${duration}s`)

    if (errors.length) {
      const report = errors.map(({ type, route, error }) => {
        /* istanbul ignore if */
        if (type === 'unhandled') {
          return `Route: '${route}'\n${error.stack}`
        } else {
          return `Route: '${route}' thrown an error: \n` + JSON.stringify(error)
        }
      })
      console.error('==== Error report ==== \n' + report.join('\n\n')) // eslint-disable-line no-console
    }

    return { duration, errors }
  }
}
