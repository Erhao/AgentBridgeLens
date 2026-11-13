<script setup lang="ts">
import {
  ElButton, ElCheckbox, ElCollapse, ElCollapseItem, ElColorPicker, ElConfigProvider,
  ElForm, ElFormItem, ElInput, ElInputNumber, ElOption, ElSelect, ElSwitch,
} from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/checkbox/style/css";
import "element-plus/es/components/collapse/style/css";
import "element-plus/es/components/collapse-item/style/css";
import "element-plus/es/components/color-picker/style/css";
import "element-plus/es/components/form/style/css";
import "element-plus/es/components/form-item/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/input-number/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/switch/style/css";
import { usePanelState } from "./panel-state";

const {
  ready, settings, consent, consentDraft, sections, openServices, services, connectionHint, activityText, targetText,
  tabs, targets, policies, globalPolicy, targetBusy, targetMode, targetPage, BRIDGE_COLORS, bridge, serviceActive,
  serviceStatus, serviceClass, serviceUrl, serviceProgress, saveService, addService, cancelService, deleteService,
  reconnect, setPreference, setDuration, applyConsent, setTargets, changeTargetMode, setPolicy, tabHost,
} = usePanelState();
</script>

<template>
  <ElConfigProvider :locale="zhCn" size="small">
    <main class="bl">
      <h1 class="bl-h1">AgentBridgeLens</h1>
      <p v-if="!ready" role="status">正在载入设置…</p>
      <template v-else>
        <h2 class="bl-h2">桥接服务</h2>
        <ElCollapse id="bl-services" v-model="openServices" class="bl-services">
          <ElCollapseItem v-for="service in services" :key="service.profile.id" :name="service.profile.id"
            :data-service-id="service.profile.id" :class="['bl-bridge-line', serviceClass(service)]"
            :style="{ '--accent': service.profile.color || BRIDGE_COLORS[0] }">
            <template #title>
              <span class="bl-bridge-info">
                <span class="bl-bridge-heading">
                  <strong>{{ serviceStatus(service) }} · {{ service.profile.name }}</strong>
                  <ElButton v-if="serviceActive(service) && !bridge(service)?.connected" class="bl-reconnect"
                    :aria-label="`立即重连 ${service.profile.name}`" :loading="service.retrying"
                    @click.stop="reconnect(service)" @keydown.stop>立即重连</ElButton>
                </span>
                <span class="bl-bridge-url">{{ serviceUrl(service) }}</span>
                <span class="bl-bridge-progress">{{ serviceProgress(service) }}</span>
                <span v-if="serviceActive(service) && bridge(service)?.lastError" class="bl-bridge-error">最近错误：{{ bridge(service)?.lastError }}</span>
              </span>
            </template>
            <ElForm class="bl-bridge-editor" label-position="top" @submit.prevent="saveService(service)">
              <ElFormItem label="服务名称"><ElInput v-model="service.draft.name" name="name" placeholder="例如：开发机 / 笔记本" /></ElFormItem>
              <ElFormItem label="服务强调色">
                <div class="bl-color-field">
                  <ElColorPicker v-model="service.draft.color" :predefine="BRIDGE_COLORS" color-format="hex" aria-label="选择服务强调色" />
                  <ElInput v-model="service.draft.color" name="color" aria-label="服务强调色 HEX" maxlength="7" />
                </div>
              </ElFormItem>
              <ElFormItem><ElSwitch v-model="service.draft.enabled" name="enabled" aria-label="启用此服务" active-text="启用此服务" /></ElFormItem>
              <ElFormItem label="Host"><ElInput v-model="service.draft.host" name="host" placeholder="127.0.0.1" /></ElFormItem>
              <ElFormItem label="Port"><ElInputNumber v-model="service.draft.port" name="port" :min="1" :max="65535" :step="1" :controls="false" aria-label="Port" /></ElFormItem>
              <ElFormItem label="Token（跨机时必填）"><ElInput v-model="service.draft.token" name="token" type="password" placeholder="BRIDGELENS_TOKEN" autocomplete="off" show-password /></ElFormItem>
              <ElButton class="bl-service-save" type="primary" native-type="submit" :loading="service.busy">保存此服务</ElButton>
              <div class="bl-service-actions">
                <ElButton data-action="cancel" :disabled="service.busy" @click="cancelService(service)">取消</ElButton>
                <ElButton v-if="service.saved" data-action="delete" type="danger" plain :disabled="service.busy" @click="deleteService(service)">删除服务</ElButton>
              </div>
              <p v-if="service.error" class="bl-bridge-message bad" role="alert">{{ service.error }}</p>
            </ElForm>
          </ElCollapseItem>
        </ElCollapse>
        <p id="bl-status" class="bl-help" role="status">{{ connectionHint }}</p>
        <ElButton id="bl-add" class="bl-add" type="primary" plain @click="addService">＋ 添加服务</ElButton>

        <div class="bl-setting-row bl-panel-setting">
          <span>面板内显示实时状态</span>
          <ElSwitch id="bl-activity-enabled" v-model="settings.panel" aria-label="面板内显示实时状态" @change="value => setPreference('activityDisplayEnabled', value)" />
        </div>
        <section class="bl-toast-settings" aria-label="网页悬浮提示设置">
          <div class="bl-setting-row">
            <span>网页自动显示悬浮状态</span>
            <ElSwitch id="bl-toast-enabled" v-model="settings.toast" aria-label="网页自动显示悬浮状态" @change="value => setPreference('activityToastEnabled', value)" />
          </div>
          <div class="bl-setting-row bl-retention" :class="{ 'is-disabled': !settings.toast }">
            <label for="bl-toast-seconds">完成后保留</label>
            <div class="bl-duration-field">
              <ElInputNumber id="bl-toast-seconds" v-model="settings.seconds" :min="0" :max="300" :step="0.1"
                controls-position="right" :disabled="!settings.toast" aria-label="完成后保留秒数" @change="setDuration" />
              <span>秒</span>
            </div>
          </div>
          <p class="bl-help">执行中持续显示，鼠标移入可固定。</p>
        </section>
        <div v-if="settings.panel" id="bl-activity" class="bl-activity" role="status" aria-live="polite">{{ activityText }}</div>

        <ElCollapse v-model="sections" class="bl-sections">
          <ElCollapseItem id="bl-privacy" name="privacy" title="数据访问与授权">
            <div class="bl-privacy">
              <p>连接后，AI 可通过你配置的 Bridge 读取标签页信息、网页内容、截图、调试日志，并执行网页操作；启动录制后还可记录输入内容。数据会发送到 Bridge 及其连接的 AI 客户端，可能离开本机。请仅连接可信服务，并避免在敏感页面使用。</p>
              <a href="/privacy.html" target="_blank" rel="noopener">隐私政策 / Privacy policy</a>
              <ElCheckbox id="bl-consent" v-model="consentDraft">我同意上述数据访问和传输，并启用 Bridge 连接</ElCheckbox>
              <ElButton id="bl-apply-consent" type="primary" plain @click="applyConsent">应用授权设置</ElButton>
            </div>
          </ElCollapseItem>
        </ElCollapse>
        <section class="bl-target-section">
          <h2 class="bl-h2">操作页面</h2>
          <ElForm label-position="top">
            <ElFormItem label="操作方式">
              <ElSelect id="bl-target-mode" :model-value="targetMode" aria-label="操作方式" :disabled="targetBusy"
                popper-class="bl-select-dropdown" @change="changeTargetMode">
                <ElOption label="操作当前页" value="current" /><ElOption label="固定指定页" value="pinned" />
              </ElSelect>
            </ElFormItem>
            <ElFormItem v-if="targetMode === 'pinned'" id="bl-page-picker" label="指定页面">
              <ElSelect id="bl-target-page" :model-value="targetPage" filterable :disabled="targetBusy" aria-label="选择固定操作的页面"
                :placeholder="targets.length > 1 ? `已固定 ${targets.length} 个页面` : '选择页面'" popper-class="bl-select-dropdown"
                @change="value => setTargets([value])">
                <ElOption v-for="tab in tabs" :key="tab.id" :label="tab.title || '(无标题)'" :value="tab.id!" />
              </ElSelect>
            </ElFormItem>
          </ElForm>
          <div id="bl-target" class="bl-target">{{ targetText }}</div>
          <p class="bl-help">操作当前页会随你切换标签页；固定后，切换标签页也会继续操作指定页面。</p>
          <ElCollapse v-model="sections" class="bl-sections">
            <ElCollapseItem id="bl-target-advanced" name="advanced" title="高级设置：多目标与新标签跟随">
              <p class="bl-help">可添加多个固定页面，并选择是否自动加入它打开的新标签。多个目标时优先使用当前激活的目标，否则使用最后加入的目标。AI 明确指定页面时以指定页面为准；所有 Bridge 共用此设置。</p>
              <h3 class="bl-h2">固定页面 <ElButton id="bl-clear-all" link type="primary" @click="setTargets([])">全部取消</ElButton></h3>
              <div id="bl-tablist">
                <div v-for="tab in tabs" :key="tab.id" class="bl-tab" :class="{ 'is-target': targets.includes(tab.id!) }">
                  <div class="bl-tab-meta"><div class="bl-tab-title">{{ tab.title || '(无标题)' }}</div><div class="bl-tab-url">{{ tabHost(tab) }}</div></div>
                  <template v-if="targets.includes(tab.id!)">
                    <ElSelect :model-value="policies[String(tab.id)] || globalPolicy" :aria-label="`${tab.title} 的新标签策略`" popper-class="bl-select-dropdown" @change="value => setPolicy(tab.id!, value)">
                      <ElOption label="不跟随" value="stay" /><ElOption label="跟随新标签" value="follow" />
                    </ElSelect>
                    <ElButton @click="setTargets(targets.filter(id => id !== tab.id))">取消</ElButton>
                  </template>
                  <ElButton v-else type="primary" plain @click="setTargets([...targets, tab.id!])">设为目标</ElButton>
                </div>
              </div>
            </ElCollapseItem>
          </ElCollapse>
        </section>
      </template>
    </main>
  </ElConfigProvider>
</template>

<style>
:root { --el-color-primary:#409eff; --el-font-size-base:13px; --el-font-size-small:12px; --el-border-radius-base:6px; font-family:system-ui,sans-serif; color:#303133; }
body { margin:0; font-size:13px; }
* { box-sizing:border-box; }
.bl { width:100%; min-width:0; }
.bl-h1 { font-size:15px; line-height:1.5; margin:0 0 14px; }
.bl-h2 { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; color:#909399; font-weight:600; margin:0 0 8px; }
.bl-services { border:0; }
.bl-bridge-line { margin-bottom:8px; border:1px solid #e4e7ed; border-left:4px solid var(--accent); border-radius:8px; overflow:hidden; }
.bl-bridge-line.ok { background:#f0f9eb; }
.bl-bridge-line.bad { background:#fef0f0; }
.bl-bridge-line.pending { background:#f4f4f5; }
.bl-bridge-line > .el-collapse-item__header { height:auto; min-height:64px; padding:10px; background:transparent; border:0; line-height:1.5; }
.bl-bridge-line > .el-collapse-item__wrap { border:0; }
.bl-bridge-line .el-collapse-item__content { padding-bottom:0; }
.bl-bridge-line.ok .bl-bridge-heading { color:#529b2e; }
.bl-bridge-line.bad .bl-bridge-heading { color:#c45656; }
.bl-bridge-info { display:block; width:100%; min-width:0; text-align:left; }
.bl-bridge-heading { display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:12px; }
.bl-bridge-heading strong { min-width:0; overflow-wrap:anywhere; }
.bl-bridge-url,.bl-bridge-progress { display:block; font-size:12px; color:#606266; font-weight:400; overflow-wrap:anywhere; }
.bl-bridge-error,.bl-bridge-message.bad { display:block; font-size:12px; color:#c45656; white-space:pre-line; overflow-wrap:anywhere; }
.bl-bridge-editor { padding:12px; background:white; }
.bl .el-form-item { margin-bottom:12px; }
.bl .el-form-item__label { line-height:1.5; margin-bottom:5px!important; font-size:12px; }
.bl .el-input-number,.bl .el-select { width:100%; }
.bl .el-input-number .el-input__inner { text-align:left; }
.bl-color-field { display:flex; align-items:center; width:100%; gap:8px; }
.bl-service-save { width:100%; }
.bl-service-actions { display:flex; margin-top:8px; }
.bl .el-button { min-height:28px; }
.bl-add.el-button { width:100%; margin:4px 0 12px; border-style:dashed; background:white; }
.bl-setting-row { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:32px; font-size:12px; }
.bl-setting-row > span:first-child { min-width:0; }
.bl-panel-setting { margin-bottom:8px; padding:0 2px; }
.bl-toast-settings { padding:10px 12px; margin-bottom:12px; border:1px solid #d9ecff; border-radius:8px; background:#f5faff; }
.bl-retention { margin-top:8px; padding-top:8px; border-top:1px solid #e3effc; }
.bl-retention.is-disabled { color:#a8abb2; }
.bl-duration-field { display:flex; align-items:center; gap:6px; flex:none; }
.bl-duration-field .el-input-number { width:94px; }
.bl-duration-field .el-input__inner { text-align:center; }
.bl-help { margin:6px 0; color:#909399; font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
.bl-toast-settings > .bl-help { margin:8px 0 0; }
.bl-activity { border-radius:6px; background:#f4f4f5; padding:8px 10px; margin-bottom:10px; font-size:12px; white-space:pre-line; overflow-wrap:anywhere; }
.bl-sections { border:0; }
.bl-sections > .el-collapse-item > .el-collapse-item__header { min-height:32px; height:auto; line-height:1.5; border:0; color:var(--el-color-primary); font-size:12px; padding:6px 0; }
.bl-sections .el-collapse-item__wrap { border:0; }
.bl-sections .el-collapse-item__content { padding-bottom:8px; }
.bl-privacy { padding:10px; border-radius:6px; background:#f4f7fb; font-size:12px; line-height:1.6; }
.bl-privacy p { margin:0 0 6px; }
.bl-privacy a { color:var(--el-color-primary); }
.bl-privacy .el-checkbox { height:auto; white-space:normal; align-items:flex-start; margin:10px 0; }
.bl-privacy .el-checkbox__input { margin-top:3px; }
.bl-privacy .el-checkbox__label { white-space:normal; font-size:12px; }
.bl-target-section { border-top:1px solid #ebeef5; margin-top:10px; padding-top:14px; }
.bl-target { border-radius:6px; padding:7px 10px; background:#ecf5ff; font-size:12px; overflow-wrap:anywhere; }
#bl-tablist { max-height:380px; overflow:auto; border:1px solid #ebeef5; border-radius:6px; }
.bl-tab { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:8px; border-bottom:1px solid #f2f3f5; }
.bl-tab:last-child { border:0; }
.bl-tab.is-target { background:#f0f9eb; }
.bl-tab-meta { flex:1; min-width:80px; }
.bl-tab-title,.bl-tab-url { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bl-tab-url { color:#909399; }
.bl-tab .el-select { width:104px; }
.bl-select-dropdown { max-width:calc(100vw - 16px); }
.bl-select-dropdown .el-select-dropdown__item { max-width:calc(100vw - 24px); overflow:hidden; text-overflow:ellipsis; }
@media (max-width:320px) { .bl-toast-settings { padding:8px; } .bl-setting-row { gap:6px; } }
</style>
