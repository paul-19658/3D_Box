<template>
  <div class="login">
    <form class="login__card" @submit.prevent="submit">
      <h1 class="login__title">小白盒</h1>
      <p class="login__hint">输入账号名即可进入。账号不存在时会自动创建。</p>
      <label class="field">
        <span class="field__label">账号</span>
        <input
          v-model.trim="username"
          class="input"
          maxlength="64"
          autocomplete="username"
          autofocus
          placeholder="例如：张三"
        />
      </label>
      <p v-if="error" class="error-line">{{ error }}</p>
      <button type="submit" class="btn btn--primary login__submit" :disabled="submitting || !username">
        {{ submitting ? '进入中…' : '进入' }}
      </button>
    </form>
  </div>
</template>

<script>
export default {
  name: 'LoginView',

  data() {
    return {
      username: '',
      submitting: false,
      error: ''
    }
  },

  methods: {
    async submit() {
      if (!this.username || this.submitting) return
      this.submitting = true
      this.error = ''
      try {
        await this.$store.dispatch('login', this.username)
        const redirect = this.$route.query.redirect || '/editor'
        this.$router.replace(typeof redirect === 'string' ? redirect : '/editor')
      } catch (error) {
        this.error = error.message || '登录失败'
      } finally {
        this.submitting = false
      }
    }
  }
}
</script>

<style scoped>
.login {
  display: grid;
  place-items: center;
  min-height: 100%;
  padding: 24px;
  background: var(--bg-0);
}

.login__card {
  width: min(360px, 100%);
  padding: 28px 24px 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  background: var(--bg-1);
  box-shadow: var(--shadow-pop);
}

.login__title {
  margin: 0 0 8px;
  font-size: 22px;
  font-weight: 700;
}

.login__hint {
  margin: 0 0 18px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}

.login__submit {
  width: 100%;
  margin-top: 16px;
}

.error-line {
  margin: 10px 0 0;
  color: var(--danger);
  font-size: 12px;
}
</style>
