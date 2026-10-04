<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useScheduleStore } from "./stores/schedule";

const store = useScheduleStore();
const route = useRoute();
const { t } = useI18n();
const isOnline = computed({
  get: () => store.online,
  set: (value: boolean) => store.setOnline(value)
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span>SC</span>
        <div><b>现场制片台</b><small>Schedule Control</small></div>
      </div>
      <nav>
        <RouterLink to="/" :class="{ active: route.name === 'schedule' }">◫ {{ t("schedule") }}</RouterLink>
        <RouterLink to="/conflicts" :class="{ active: route.name === 'conflicts' }">△ {{ t("conflicts") }} <em>{{ store.conflicts.length }}</em></RouterLink>
        <RouterLink to="/history" :class="{ active: route.name === 'history' }">↺ 操作单元 / 撤销 <em v-if="store.pendingUndos.length">{{ store.pendingUndos.length }}</em></RouterLink>
      </nav>
      <div class="network-card">
        <label>运行模式</label>
        <el-switch v-model="isOnline" active-text="在线" inactive-text="离线" />
        <small>{{ isOnline ? "操作以操作单元写入服务端，按编号乐观提交" : "离线时撤销进入待办清单，恢复后从原基线重试" }}</small>
        <label style="margin-top:6px">服务端最新操作编号</label>
        <b class="seq-badge">#{{ store.ledgerSeq }}</b>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div>
          <small>拍摄日 2026-10-08 · 项目《潮汐线》</small>
          <h1>影视剧组通告与资源冲突编排</h1>
        </div>
        <label class="role-picker">当前身份
          <select :value="store.currentActorId" @change="store.switchActor(($event.target as HTMLSelectElement).value)">
            <option v-for="item in store.actors" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
      </header>
      <el-alert
        v-if="store.lastFailure"
        class="commit-alert"
        :closable="true"
        type="error"
        show-icon
        @close="store.clearNotice()"
      >
        <template #title>
          <span>{{ store.lastFailure.message }}</span>
          <span class="alert-meta">最新操作编号 #{{ store.lastFailure.latestSeq }} · 现存冲突 {{ store.lastFailure.conflicts.length }} 项<span v-if="store.lastFailure.requiredRole"> · 需要 {{ store.lastFailure.requiredRole }} 权限</span></span>
        </template>
      </el-alert>
      <el-alert v-else-if="store.notice" class="commit-alert" :closable="true" type="success" show-icon @close="store.clearNotice()" :title="store.notice" />
      <RouterView />
    </main>
  </div>
</template>
