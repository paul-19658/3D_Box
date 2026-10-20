import Vue from 'vue'
import Router from 'vue-router'
import Editor from '@/views/Editor.vue'
import Projects from '@/views/Projects.vue'

Vue.use(Router)

/**
 * 路由与界面状态同步（vuex-router-sync）：
 * 路由是"当前在哪个页面"的唯一来源，store 通过 `state.route` 只读访问。
 * 反过来，组件不直接改 `state.route`，而是 router.push。
 */
export default new Router({
  mode: 'history',
  routes: [
    { path: '/', redirect: '/editor' },
    { path: '/editor', name: 'editor', component: Editor },
    { path: '/projects', name: 'projects', component: Projects },
    { path: '*', redirect: '/editor' }
  ]
})
