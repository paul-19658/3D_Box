import Vue from 'vue'
import Router from 'vue-router'
import Editor from '@/views/Editor.vue'
import Projects from '@/views/Projects.vue'
import Login from '@/views/Login.vue'
import Admin from '@/views/Admin.vue'
import store from '@/store'
import { setUnauthorizedHandler } from '@/api/client'

Vue.use(Router)

/**
 * 路由与界面状态同步（vuex-router-sync）：
 * 路由是"当前在哪个页面"的唯一来源，store 通过 `state.route` 只读访问。
 * 反过来，组件不直接改 `state.route`，而是 router.push。
 */
const router = new Router({
  mode: 'history',
  routes: [
    { path: '/login', name: 'login', component: Login, meta: { public: true } },
    { path: '/', redirect: '/editor' },
    { path: '/editor', name: 'editor', component: Editor },
    { path: '/projects', name: 'projects', component: Projects },
    { path: '/admin', name: 'admin', component: Admin, meta: { requiresAdmin: true } },
    { path: '*', redirect: '/editor' }
  ]
})

let authReady = null

function ensureAuth() {
  if (!authReady) {
    authReady = store.dispatch('fetchCurrentUser').finally(() => {
      // 允许登出后再次探测。
    })
  }
  return authReady
}

export function resetAuthProbe() {
  authReady = null
}

setUnauthorizedHandler(() => {
  resetAuthProbe()
  store.commit('setCurrentUser', null)
  if (router.currentRoute.path !== '/login') {
    router.replace({ path: '/login', query: { redirect: router.currentRoute.fullPath } })
  }
})

router.beforeEach(async (to, from, next) => {
  if (to.meta && to.meta.public) {
    next()
    return
  }

  await ensureAuth()
  if (!store.state.currentUser) {
    next({ path: '/login', query: { redirect: to.fullPath } })
    return
  }

  if (to.meta && to.meta.requiresAdmin && !store.getters.isAdmin) {
    next({ path: '/editor' })
    return
  }

  next()
})

export default router
