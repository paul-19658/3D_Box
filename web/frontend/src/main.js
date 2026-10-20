import Vue from 'vue'
import { sync } from 'vuex-router-sync'
import App from './App.vue'
import store from './store'
import router from './router'
import { installDiagnostics } from './core/diagnostics'
import './styles/index.css'

Vue.config.productionTip = false

// 必须在创建根实例之前挂载：Vue.config.errorHandler 只有提前设置，
// 才能捕获组件 mounted 阶段抛出的异常——那正是"黑屏"的高发位置。
installDiagnostics(Vue)

// 把 router 的当前路由同步进 store，组件可以从唯一的状态源读取路由信息。
sync(store, router)

new Vue({
  router,
  store,
  render: (createElement) => createElement(App)
}).$mount('#app')
