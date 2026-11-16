<template>
  <section class="inspector">
    <header class="inspector__head">
      <span>{{ title }}</span>
      <div class="tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="tab"
          :class="{ 'is-active': activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>
    </header>

    <div class="inspector__body">
      <!-- ---------------------------------------------------------- -->
      <!-- 物体属性                                                    -->
      <!-- ---------------------------------------------------------- -->
      <template v-if="target === 'selection' && object">
        <div class="panel__section">
          <p class="section-title">{{ kindLabel }} · {{ object.id.slice(0, 8) }}</p>
          <label class="field">
            <span class="field__label">名称</span>
            <input class="input" :value="object.name" @change="patch({ name: value($event) })" />
          </label>
          <label class="field">
            <span class="field__label">颜色</span>
            <input
              class="input"
              type="color"
              :value="object.color"
              @input="patch({ color: $event.target.value })"
            />
          </label>
          <label class="field">
            <span class="field__label">描述</span>
            <input
              class="input"
              :value="object.description || ''"
              placeholder="给 AI 的补充说明"
              @change="patch({ description: value($event) })"
            />
          </label>
          <label v-if="object.kind !== 'mannequin' && object.kind !== 'imported'" class="field">
            <span class="field__label">显示</span>
            <select
              class="select"
              :value="object.displayMode || 'solid'"
              @change="patch({ displayMode: $event.target.value })"
            >
              <option value="solid">实体</option>
              <option value="transparent">半透明</option>
              <option value="wireframe">线框</option>
            </select>
          </label>
        </div>

        <div class="panel__section">
          <p class="section-title">变换</p>
          <div v-if="object.locked" class="drive-notice">
            <p>物体已锁定。请先在资产列表点开锁图标，再拖拽或改坐标。</p>
          </div>
          <div v-else-if="transformDriven" class="drive-notice">
            <p>
              <template v-if="objectKeyframeCount > 0">
                时间轴上有 {{ objectKeyframeCount }} 个该物体关键帧，视口位置由关键帧（及播放头时刻）决定，手动改 XYZ
                会被盖掉。
              </template>
              <template v-if="object.pathBinding">
                <template v-if="objectKeyframeCount > 0"> </template>
                当前还绑定了导航线，位置/朝向由路径接管。
              </template>
            </p>
            <div class="drive-notice__actions">
              <button
                v-if="objectKeyframeCount > 0"
                type="button"
                class="btn btn--ghost"
                @click="$emit('clear-object-keyframes', object.id)"
              >
                清除该物体关键帧
              </button>
              <button
                v-if="object.pathBinding"
                type="button"
                class="btn btn--ghost"
                @click="bindPath({ target: { value: '' } })"
              >
                取消路径绑定
              </button>
            </div>
          </div>
          <div class="field">
            <span class="field__label">位置</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`p-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :disabled="object.locked"
                :value="round(object.position[axis])"
                @change="patchVector('position', axis, $event)"
              />
            </div>
          </div>
          <div class="field">
            <span class="field__label">旋转</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`r-${axis}`"
                class="input"
                type="number"
                step="1"
                :disabled="object.locked"
                :value="round(object.rotation[axis])"
                @change="patchVector('rotation', axis, $event)"
              />
            </div>
          </div>
          <div class="field">
            <span class="field__label">尺寸</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`s-${axis}`"
                class="input"
                type="number"
                step="0.1"
                min="0.1"
                :disabled="object.locked"
                :value="round(object.size[axis])"
                @change="patchVector('size', axis, $event)"
              />
            </div>
          </div>
        </div>

        <div v-if="object.mannequin" class="panel__section">
          <p class="section-title">人台</p>
          <label class="field">
            <span class="field__label">动作</span>
            <select class="select" :value="presetValue" @change="preset($event)">
              <!--
                `presetId === null` 表示"没有动作预设"（应用姿势库 / 手摆姿势后就是这个状态）。
                没有这一项时下拉框会显示第一个预设（站立），而数据是 null——
                用户会以为"我明明选的是站立"，其实外观完全由手动关节驱动。
              -->
              <option v-if="!object.mannequin.presetId" value="">自定义姿势</option>
              <option v-for="item in presets" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">身高</span>
            <input
              class="input"
              type="number"
              step="0.01"
              min="1.2"
              max="2.2"
              :value="round(object.mannequin.heightMeters)"
              @change="$emit('update-height', { id: object.id, heightMeters: Number($event.target.value) })"
            />
          </label>
        </div>

        <!--
          姿势参数面板（Live2D / VTube 那种"一条参数一根滑块"）。

          每个关节三个轴 —— 与 MANNEQUIN_JOINTS 的 limits 一一对应，
          滑块范围直接取限位，所以不可能拖出反折的角度。
        -->
        <div v-if="object.mannequin" class="panel__section pose-panel">
          <div class="pose-panel__head">
            <p class="section-title">姿势（关节参数）</p>
            <div class="pose-panel__actions">
              <button
                type="button"
                class="mini-btn pose-keyframe-all"
                title="在当前播放头时刻为这个物体的全部关节插入（或覆盖）姿势关键帧"
                @click="$emit('keyframe-pose', { id: object.id, jointIds: null })"
              >
                为全部关节打帧
              </button>
              <button
                type="button"
                class="mini-btn"
                title="回到预设姿势（没有预设则回到中立姿势）"
                @click="$emit('reset-mannequin-pose', { id: object.id })"
              >
                重置全部
              </button>
            </div>
          </div>

          <!--
            一键镜像：把一侧四肢的角度**对称**到另一侧。

            只处理四肢配对关节（肩/肘/髋/膝），不动 `head` / `spine`：
            用户自己扭过的躯干是刻意摆的，一键镜像把它一起改掉反而更意外。
            取舍与数学推导见 core/mannequin.js 的 mirrorMannequinPose()。
          -->
          <div class="pose-mirror">
            <span class="pose-mirror__label">左右镜像</span>
            <button
              type="button"
              class="mini-btn pose-mirror__left"
              title="把左侧四肢的角度镜像到右侧（头/躯干保持不动）"
              @click="$emit('mirror-pose', { id: object.id, fromSide: 'left' })"
            >
              左 → 右
            </button>
            <button
              type="button"
              class="mini-btn pose-mirror__right"
              title="把右侧四肢的角度镜像到左侧（头/躯干保持不动）"
              @click="$emit('mirror-pose', { id: object.id, fromSide: 'right' })"
            >
              右 → 左
            </button>
          </div>

          <!--
            姿势库：把当前整套关节角度命名保存，随时切回。

            名字用**内联输入框**而不是 window.prompt：prompt 是浏览器原生模态，
            自动化测试驱动不了，用户也没法一边看着画面一边想名字。
          -->
          <div class="pose-library">
            <p class="pose-library__title">姿势库</p>
            <div class="pose-library__save">
              <input
                v-model="poseName"
                class="input pose-library__input"
                type="text"
                :maxlength="poseNameMaxLength"
                placeholder="给当前姿势起个名字"
                @keyup.enter="savePose"
              />
              <button type="button" class="mini-btn pose-library__save-btn" @click="savePose">
                保存当前姿势
              </button>
            </div>
            <p v-if="poseLibrary.length === 0" class="pose-library__empty">
              还没有保存过姿势。调好关节角度、起个名字保存，随时可以切回来。
            </p>
            <div v-else class="pose-library__list">
              <div v-for="entry in poseLibrary" :key="entry.id" class="pose-library__entry">
                <span class="pose-library__entry-name" :title="entry.name || '未命名姿势'">
                  {{ entry.name || '未命名姿势' }}
                </span>
                <button
                  type="button"
                  class="mini-btn pose-library__apply"
                  title="把这个姿势应用到当前人台"
                  @click="applyPoseEntry(entry)"
                >
                  应用
                </button>
                <button
                  type="button"
                  class="mini-btn pose-library__update"
                  title="用当前姿势覆盖这一条"
                  @click="updatePoseEntry(entry)"
                >
                  更新为当前
                </button>
                <button
                  type="button"
                  class="mini-btn pose-library__delete"
                  title="从工程里删掉这一条"
                  @click="deletePoseEntry(entry)"
                >
                  删除
                </button>
              </div>
            </div>
          </div>

          <div v-for="group in jointGroups" :key="group.label" class="pose-group">
            <p class="pose-group__title">{{ group.label }}</p>
            <div v-for="joint in group.joints" :key="joint.id" class="pose-joint">
              <div class="pose-joint__head">
                <span class="pose-joint__label">{{ joint.label }}</span>
                <span class="pose-joint__tools">
                  <!--
                    逐关节打帧：只把这个关节写进当前时刻的关键帧，
                    其它关节的通道不受影响——"只动画左臂"就是这么来的。
                  -->
                  <button
                    type="button"
                    class="mini-btn pose-joint__key"
                    :title="`在当前时刻为「${joint.label}」插入（或覆盖）关键帧`"
                    @click="keyframeJoint(joint.id)"
                  >
                    打帧
                  </button>
                  <span
                    class="pose-joint__overridden"
                    :class="{ 'is-on': isManuallyPosed(joint.id) }"
                    :title="isManuallyPosed(joint.id) ? '已手动调整（会覆盖动作预设）' : '跟随动作预设'"
                  >
                    {{ isManuallyPosed(joint.id) ? '手动' : '预设' }}
                  </span>
                </span>
              </div>
              <label v-for="axis in jointAxes" :key="axis.key" class="pose-axis">
                <span class="pose-axis__name" :title="axis.title">{{ axis.label }}</span>
                <input
                  class="pose-axis__range"
                  type="range"
                  :min="joint.limits[axis.key][0]"
                  :max="joint.limits[axis.key][1]"
                  step="1"
                  :value="jointAngle(joint.id, axis.key)"
                  :disabled="isAxisLocked(joint, axis.key)"
                  :title="`${joint.label} ${axis.label}：${joint.limits[axis.key][0]}° ~ ${joint.limits[axis.key][1]}°`"
                  @input="changeJoint(joint.id, axis.key, $event.target.value)"
                />
                <span class="pose-axis__value">{{ round(jointAngle(joint.id, axis.key)) }}°</span>
              </label>
            </div>
          </div>
          <p class="field-hint">
            拖动即实时预览。手动调过的关节会显示「手动」，并覆盖上方选择的动作预设；
            点「重置全部」可回到预设姿势。
          </p>
        </div>

        <div v-if="object.kind === 'imported' && object.importedAsset" class="panel__section">
          <p class="section-title">导入模型</p>
          <p class="meta-line">{{ object.importedAsset.sourceName }}</p>
          <p class="meta-line">
            {{ object.importedAsset.report.meshCount }} 网格 ·
            {{ object.importedAsset.report.triangleCount.toLocaleString() }} 三角面
          </p>
          <label class="field">
            <span class="field__label">预览</span>
            <select
              class="select"
              :value="object.previewQuality || 'original'"
              @change="patch({ previewQuality: $event.target.value })"
            >
              <option value="original">原始精度</option>
              <option value="lightweight">轻量预览</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">导出</span>
            <select
              class="select"
              :value="object.exportQuality || 'original'"
              @change="patch({ exportQuality: $event.target.value })"
            >
              <option value="original">原始精度</option>
              <option value="lightweight">轻量模型</option>
            </select>
          </label>
        </div>

        <!-- ---------------------------------------------------------- -->
        <!-- 导航线：节点编辑 + 绑定关系                                  -->
        <!-- ---------------------------------------------------------- -->
        <div v-if="object.kind === 'path'" class="panel__section">
          <p class="section-title">导航线</p>
          <p class="meta-line">
            共 {{ pathNodes.length }} 个节点。节点时刻由弧长比例自动分配：
            总时长 {{ round(timelineDuration) }} 秒下，第 {{ pathNodes.length }} 个节点落在
            {{ formatTime(nodeTimes[nodeTimes.length - 1] || 0) }}。
          </p>
          <div class="btn-grid">
            <button type="button" class="btn" @click="$emit('path-add-node', object.id)">
              在最长段加节点
            </button>
            <button
              type="button"
              class="btn"
              :disabled="selectedNodeIndex === null"
              @click="removeSelectedNode"
            >
              删除选中节点
            </button>
            <button type="button" class="btn" @click="$emit('path-draw-again', object.id)">
              继续绘制
            </button>
            <button
              type="button"
              class="btn"
              :disabled="pathNodes.length < 2"
              @click="$emit('path-clear-nodes', object.id)"
            >
              清空节点
            </button>
          </div>

          <p class="section-title asset-panel__gap">节点列表</p>
          <p v-if="pathNodes.length === 0" class="meta-line">
            还没有节点。点"继续绘制"在场景里按住左键画一条，或点"在最长段加节点"。
          </p>
          <div
            v-for="node in pathNodes"
            :key="`node-${node.index}`"
            class="list-row"
            :class="{ 'is-active': node.index === selectedNodeIndex }"
            @click="$emit('path-select-node', { pathId: object.id, index: node.index })"
          >
            <span class="node-index">{{ node.index + 1 }}</span>
            <span class="list-row__name">X {{ round(node.x) }} · Z {{ round(node.z) }}</span>
            <span class="list-row__meta">{{ formatTime(nodeTimes[node.index] || 0) }}</span>
          </div>
        </div>

        <!-- 任意物体都能绑定到导航线上。 -->
        <div v-if="object.kind !== 'path' && paths.length > 0" class="panel__section">
          <p class="section-title">沿导航线运动</p>
          <label class="field">
            <span class="field__label">绑定</span>
            <select class="select" :value="bindingPathId" @change="bindPath($event)">
              <option value="">不绑定</option>
              <option v-for="path in paths" :key="path.id" :value="path.id">{{ path.name }}</option>
            </select>
          </label>
          <template v-if="object.pathBinding">
            <label class="field">
              <span class="field__label">朝向</span>
              <select
                class="select"
                :value="object.pathBinding.followRotation === false ? 'fixed' : 'path'"
                @change="patchBinding({ followRotation: $event.target.value === 'path' })"
              >
                <option value="path">跟随路径方向</option>
                <option value="fixed">保持自身朝向</option>
              </select>
            </label>
            <label class="field">
              <span class="field__label">时间偏移</span>
              <input
                class="input"
                type="number"
                step="0.1"
                :value="round(object.pathBinding.offsetSeconds || 0)"
                @change="patchBinding({ offsetSeconds: Number($event.target.value) || 0 })"
              />
            </label>
            <label class="field">
              <span class="field__label">离地高度</span>
              <input
                class="input"
                type="number"
                step="0.1"
                :value="round(object.pathBinding.heightOffset || 0)"
                @change="patchBinding({ heightOffset: Number($event.target.value) || 0 })"
              />
            </label>
            <p class="meta-line">绑定期间该物体的位置与朝向由路径决定，拖动播放头即可看到它沿路径走。</p>
          </template>
        </div>

        <div v-if="object.kind !== 'imported' && object.kind !== 'mannequin' && object.kind !== 'path'" class="panel__section">
          <p class="section-title">面涂色</p>
          <div class="swatch-row">
            <button
              v-for="color in paintPalette"
              :key="color"
              type="button"
              class="swatch"
              :style="{ background: color }"
              :title="color"
              @click="$emit('set-paint-color', color)"
            ></button>
          </div>
          <label class="field field--top">
            <span class="field__label">范围</span>
            <select
              class="select"
              :value="paintScope"
              @change="$emit('set-paint-scope', $event.target.value)"
            >
              <option value="object">整个物体</option>
              <option value="face">单块面片</option>
            </select>
          </label>
        </div>

        <div class="panel__section">
          <p class="section-title">布局</p>
          <div class="btn-grid">
            <button type="button" class="btn" @click="$emit('apply-layout', 'align-x')">X 对齐</button>
            <button type="button" class="btn" @click="$emit('apply-layout', 'align-z')">Z 对齐</button>
            <button type="button" class="btn" @click="$emit('apply-layout', 'distribute-x')">X 等距</button>
            <button type="button" class="btn" @click="$emit('apply-layout', 'distribute-z')">Z 等距</button>
            <button type="button" class="btn" @click="$emit('apply-layout', 'ground')">落地</button>
          </div>
        </div>

        <div class="panel__section inspector__actions">
          <button type="button" class="btn" @click="$emit('duplicate-object')">复制</button>
          <button type="button" class="btn btn--danger" @click="$emit('delete-object')">删除</button>
        </div>
      </template>

      <!-- ---------------------------------------------------------- -->
      <!-- 灯光属性                                                    -->
      <!-- ---------------------------------------------------------- -->
      <template v-else-if="target === 'light' && light">
        <div class="panel__section">
          <p class="section-title">{{ lightKindLabel }} · 可编辑</p>
          <label class="field">
            <span class="field__label">名称</span>
            <input class="input" :value="light.name" @change="patchLight({ name: value($event) })" />
          </label>
          <label class="field">
            <span class="field__label">颜色</span>
            <input
              class="input"
              type="color"
              :value="light.color"
              @input="patchLight({ color: $event.target.value })"
            />
          </label>
          <label class="field">
            <span class="field__label">强度</span>
            <input
              class="input"
              type="number"
              step="0.1"
              min="0"
              max="20"
              :value="light.intensity"
              @change="patchLight({ intensity: clamp(Number($event.target.value), 0, 20) })"
            />
          </label>
        </div>

        <div class="panel__section">
          <p class="section-title">位置与朝向</p>
          <div class="field">
            <span class="field__label">位置</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`lp-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(light.position[axis])"
                @change="patchLightVector('position', axis, $event)"
              />
            </div>
          </div>
          <div class="field">
            <span class="field__label">目标</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`lt-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(light.target[axis])"
                @change="patchLightVector('target', axis, $event)"
              />
            </div>
          </div>
          <label v-if="light.kind === 'area' || light.kind === 'point'" class="field">
            <span class="field__label">尺寸</span>
            <input
              class="input"
              type="number"
              step="0.1"
              min="0.1"
              max="100"
              :value="light.size"
              @change="patchLight({ size: clamp(Number($event.target.value), 0.1, 100) })"
            />
          </label>
          <label v-if="light.kind === 'spot'" class="field">
            <span class="field__label">角度</span>
            <input
              class="input"
              type="number"
              step="1"
              min="1"
              max="89"
              :value="light.angleDegrees"
              @change="patchLight({ angleDegrees: clamp(Number($event.target.value), 1, 89) })"
            />
          </label>
          <p v-if="light.kind === 'area'" class="meta-line">
            面光不参与阴影计算，阴影由点光 / 聚光 / 日光投射。
          </p>
        </div>

        <div class="panel__section">
          <p class="section-title">添加灯光</p>
          <div class="btn-grid">
            <button type="button" class="btn" @click="$emit('add-light', 'sun')">日光</button>
            <button type="button" class="btn" @click="$emit('add-light', 'spot')">聚光灯</button>
            <button type="button" class="btn" @click="$emit('add-light', 'point')">点光源</button>
            <button type="button" class="btn" @click="$emit('add-light', 'area')">面光</button>
          </div>
        </div>

        <div class="panel__section inspector__actions">
          <button type="button" class="btn btn--danger btn--block" @click="$emit('delete-light', light.id)">
            删除灯光
          </button>
        </div>
      </template>

      <!-- ---------------------------------------------------------- -->
      <!-- 摄影机                                                      -->
      <!-- ---------------------------------------------------------- -->
      <template v-else>
        <div class="panel__section">
          <p class="section-title">摄影机</p>
          <div class="field">
            <span class="field__label">位置</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`cp-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(camera.position[axis])"
                @change="patchCameraVector('position', axis, $event)"
              />
            </div>
          </div>
          <!--
            "看向"的启用开关。
            只在**已经绑定**时才出现：没绑定时"是否启用"没有意义。
            关掉后相机回到静态 target 坐标，但绑定关系保留，
            勾回来无需重新拖拽——这是与"解除"的关键区别。
          -->
          <div v-if="camera.targetObjectId" class="field">
            <span class="field__label">看向物体</span>
            <label class="checkbox" :title="lookAtEnabledHint">
              <input
                type="checkbox"
                :checked="lookAtEnabled"
                @change="$emit('toggle-look-at', $event.target.checked)"
              />
              启用（锁定并跟随）
            </label>
          </div>
          <div class="field" :class="{ 'is-bound': targetBindingAlive && lookAtEnabled }">
            <span class="field__label">看向</span>
            <!--
              绑定**生效**时看向点由物体位置决定，数字输入没有意义，
              所以整行换成"绑定条"：显示物体名 + 解除按钮。
              保留数字输入会让人以为改了数字就能改朝向，实际改了没反应。
              开关关闭时绑定条置灰，但下面的坐标输入恢复可用——
              此时相机用的就是那组坐标。
            -->
            <div v-if="targetBindingAlive" class="bind-row" :class="{ 'is-disabled': !lookAtEnabled }">
              <span
                class="bind-chip"
                :class="{ 'is-off': !lookAtEnabled }"
                :title="lookAtEnabled ? `相机锁定「${targetBindingName}」并跟随其移动` : `已绑定「${targetBindingName}」，但当前未启用`"
              >
                <span class="bind-chip__icon" aria-hidden="true">◎</span>
                {{ targetBindingName }}
              </span>
              <button
                type="button"
                class="mini-btn"
                title="解除绑定，改为使用固定坐标"
                @click="$emit('bind-camera-target', null)"
              >
                解除
              </button>
            </div>
            <div
              v-else
              class="vector-row"
              :class="{ 'is-drop-target': targetDropActive }"
              title="把左侧物体列表里的物体拖到这里，相机会锁定并跟随它"
              @dragover.prevent="targetDropActive = true"
              @dragleave="targetDropActive = false"
              @drop.prevent="handleTargetDrop"
            >
              <input
                v-for="axis in axes"
                :key="`ct-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(camera.target[axis])"
                @change="patchCameraVector('target', axis, $event)"
              />
            </div>
          </div>
          <!--
            绑定生效但开关关闭时，仍需让用户能改那组固定坐标——
            否则关掉开关后"看向"只剩一个灰条，无从下手。
          -->
          <div v-if="targetBindingAlive && !lookAtEnabled" class="field">
            <span class="field__label">固定坐标</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`ft-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(camera.target[axis])"
                @change="patchCameraVector('target', axis, $event)"
              />
            </div>
          </div>
          <!--
            绑定失效（物体被删）时给一个明确的出口。
            不提示的话用户只会看到"看向"的数字在跳，完全联想不到是绑定。
          -->
          <p v-if="targetBindingDangling" class="field-hint field-hint--warn">
            绑定的物体已不存在，相机已退回固定坐标。
            <button type="button" class="mini-btn" @click="$emit('bind-camera-target', null)">清除绑定</button>
          </p>
          <label class="field">
            <span class="field__label">焦距</span>
            <div class="focal-row">
              <input
                class="input"
                type="number"
                step="1"
                min="3"
                max="300"
                :value="round(focalLengthMm)"
                @change="patchFocalLength($event)"
              />
              <span class="focal-unit">mm</span>
              <span class="focal-equiv" :title="`等效全画幅约 ${round(equivalentFocalMm)}mm`">
                ≈{{ round(equivalentFocalMm) }}mm 全幅
              </span>
            </div>
          </label>
          <div class="field">
            <span class="field__label">焦段</span>
            <div class="preset-row">
              <button
                v-for="preset in focalPresets"
                :key="`fl-${preset.mm}`"
                type="button"
                class="mini-btn"
                :class="{ 'is-on': Math.abs(focalLengthMm - preset.mm) < 0.5 }"
                :title="preset.label"
                @click="$emit('update-camera', { fovDegrees: fovForFocal(preset.mm) })"
              >
                {{ preset.mm }}
              </button>
            </div>
          </div>
          <label class="field">
            <span class="field__label">视场角</span>
            <div class="focal-row">
              <input
                class="input"
                type="number"
                step="1"
                :min="MIN_FOV_DEGREES"
                :max="MAX_FOV_DEGREES"
                :value="round(camera.fovDegrees)"
                @change="$emit('update-camera', { fovDegrees: clampFovDegrees(Number($event.target.value)) })"
              />
              <span class="focal-unit">° 垂直</span>
              <span class="focal-equiv" :title="`横向视场角 ${round(horizontalFov)}°`">
                横向 {{ round(horizontalFov) }}°
              </span>
            </div>
          </label>
        </div>

        <div class="panel__section">
          <p class="section-title">画幅</p>
          <div class="btn-grid">
            <button
              v-for="preset in aspectPresets"
              :key="preset.label"
              type="button"
              class="btn"
              :class="{ 'is-selected': isAspect(preset) }"
              :title="preset.hint"
              @click="applyAspect(preset)"
            >
              {{ preset.label }}
            </button>
          </div>
          <p class="meta-line">当前 {{ camera.aspectWidth }} : {{ camera.aspectHeight }}</p>
          <p class="field-hint">
            换画幅相当于换传感器：<b>镜头（焦距）不变</b>，长边视野固定，短边随比例变化。
          </p>
        </div>

        <div class="panel__section">
          <p class="section-title">全景图背景</p>
          <!--
            全景图当天空盒贴到场景四周，任何机位都像"站在那张图里"。
            图走 exports/upload 落到用户目录，工程里只记文件名。
          -->
          <div v-if="background.panoramaFileName" class="panorama-row">
            <span
              class="bind-chip"
              :title="`来自 ${background.panoramaSourceName || background.panoramaFileName}`"
            >
              <span class="bind-chip__icon" aria-hidden="true">◉</span>
              {{ background.panoramaSourceName || background.panoramaFileName }}
            </span>
            <button type="button" class="mini-btn" title="移除背景" @click="$emit('remove-panorama')">
              移除
            </button>
          </div>
          <div class="btn-grid">
            <button type="button" class="btn" @click="pickPanorama">
              {{ background.panoramaFileName ? '更换全景图…' : '选择全景图…' }}
            </button>
          </div>

          <label class="field">
            <span class="field__label">水平旋转</span>
            <input
              class="input"
              type="range"
              min="0"
              max="360"
              step="1"
              :value="background.rotateDegrees"
              @input="patchBackground({ rotateDegrees: Number($event.target.value) })"
            />
            <span class="focal-unit">{{ round(background.rotateDegrees) }}°</span>
          </label>

          <label class="field">
            <span class="field__label">背景亮度</span>
            <input
              class="input"
              type="number"
              min="0"
              max="4"
              step="0.1"
              :value="round(background.intensity)"
              @change="patchBackground({ intensity: Number($event.target.value) })"
            />
          </label>

          <label class="checkbox">
            <input
              type="checkbox"
              :checked="background.affectsLighting"
              @change="patchBackground({ affectsLighting: $event.target.checked })"
            />
            同时作为环境光照（IBL）
          </label>
          <p class="field-hint">
            推荐 <b>2:1 等距圆柱</b>全景图（如 4096×2048）。也可以直接把图片拖到视口里。
            开启"环境光照"会让物体染上全景图的色调，想要真实感再打开。
          </p>
          <input
            ref="panoramaInput"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            class="hidden-input"
            @change="handlePanoramaFile"
          />
        </div>

        <div class="panel__section">
          <p class="section-title">添加灯光</p>
          <div class="btn-grid">
            <button type="button" class="btn" @click="$emit('add-light', 'sun')">日光</button>
            <button type="button" class="btn" @click="$emit('add-light', 'spot')">聚光灯</button>
            <button type="button" class="btn" @click="$emit('add-light', 'point')">点光源</button>
            <button type="button" class="btn" @click="$emit('add-light', 'area')">面光</button>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<script>
/**
 * 属性面板：根据 `target` 在"物体 / 灯光 / 摄影机"三套表单之间切换。
 *
 * 数值输入统一用 `change` 而不是 `input`：拖拽或连续输入时不会每敲一个字符
 * 就往撤销栈压一帧，避免 Ctrl+Z 需要按很多次。
 */
import { MANNEQUIN_PRESETS, POSE_LIBRARY_NAME_MAX_LENGTH, mannequinJointGroups } from '@/core/mannequin'
import { ASPECT_PRESETS, LIGHT_KIND_LABELS } from '@/core/project-document'
import {
  FOCAL_LENGTH_PRESETS,
  MAX_FOV_DEGREES,
  MIN_FOV_DEGREES,
  aspectRatioOf,
  clampFovDegrees,
  equivalentFullFrameFocalLength,
  focalLengthFromFovDegrees,
  fovDegreesFromFocalLength,
  horizontalFovDegrees
} from '@/core/focal-length'

const KIND_LABELS = {
  box: '方块',
  cylinder: '圆柱',
  sphere: '球体',
  wall: '墙体',
  floor: '地面',
  custom: '自定义形状',
  imported: '导入模型',
  mannequin: '人台',
  path: '导航线'
}

export default {
  name: 'InspectorPanel',

  props: {
    target: { type: String, default: 'camera' },
    object: { type: Object, default: null },
    light: { type: Object, default: null },
    camera: { type: Object, required: true },
    /** 全景图背景配置（`scene.background`），见 core/project-document.js。 */
    background: { type: Object, default: () => ({}) },
    paintColor: { type: String, default: '#ff6b6b' },
    paintScope: { type: String, default: 'object' },
    /** 场景里所有导航线对象（供"绑定到导航线"下拉框使用）。 */
    paths: { type: Array, default: () => [] },
    /** 时间轴总时长：用于展示节点会被分配到哪一刻。 */
    timelineDuration: { type: Number, default: 5 },
    /** 当前选中物体在时间轴上的关键帧数量（>0 时变换由关键帧驱动）。 */
    objectKeyframeCount: { type: Number, default: 0 },
    /** 当前选中的导航线节点索引（仅当 object 是 path 时有意义）。 */
    selectedNodeIndex: { type: Number, default: null },
    /** 场景全部物体：相机"看向"绑定需要从中找被绑物体，也用于拖放校验。 */
    objects: { type: Array, default: () => [] },
    /** 姿势库（`scene.poseLibrary`），见 core/mannequin.js。 */
    poseLibrary: { type: Array, default: () => [] }
  },

  data() {
    return {
      activeTab: 'props',
      axes: ['x', 'y', 'z'],
      presets: MANNEQUIN_PRESETS,
      /** 「保存当前姿势」输入框的内容。由组件自己持有，保存后清空。 */
      poseName: '',
      /** 与 core/mannequin.js 的截断长度保持一致，避免输入框允许打出保存不了的名字。 */
      poseNameMaxLength: POSE_LIBRARY_NAME_MAX_LENGTH,
      /** 姿势面板的三个旋转轴（label 用于界面显示，key 对应 pose 里的字段）。 */
      jointAxes: [
        { key: 'x', label: 'X', title: '前后俯仰' },
        { key: 'y', label: 'Y', title: '左右扭转' },
        { key: 'z', label: 'Z', title: '侧向摆动' }
      ],
      aspectPresets: ASPECT_PRESETS,
      lightKinds: LIGHT_KIND_LABELS,
      paintPalette: ['#ff6b6b', '#ffb020', '#37c98b', '#2f7cf6', '#9b7bf6', '#e9eef1', '#6a747b'],
      focalPresets: FOCAL_LENGTH_PRESETS,
      MIN_FOV_DEGREES,
      MAX_FOV_DEGREES,
      /** 拖拽悬停在"看向"行上时为真，用来给用户一个可投放的视觉反馈。 */
      targetDropActive: false
    }
  },

  computed: {
    /** 关节按身体部位分组（供姿势参数面板渲染）。 */
    jointGroups() {
      return mannequinJointGroups()
    },
    /** 相机绑定的物体（未绑定或物体已删则为 null）。 */
    targetBoundObject() {
      const id = this.camera?.targetObjectId
      if (!id) return null
      return this.objects.find((object) => object.id === id) ?? null
    },
    /** 当前焦距（mm）。由 fovDegrees 换算而来——焦距不是独立存储的参数。 */
    focalLengthMm() {
      return focalLengthFromFovDegrees(this.camera?.fovDegrees, this.cameraAspect) ?? 0
    },
    /** 等效全画幅焦距，用于给用户一个跨画幅可比的口径。 */
    equivalentFocalMm() {
      return equivalentFullFrameFocalLength(this.focalLengthMm, this.cameraAspect) ?? 0
    },
    /** 横向视场角：摄影里说"视角"通常指水平方向，与垂直的 fov 区分开。 */
    horizontalFov() {
      return horizontalFovDegrees(this.camera?.fovDegrees, this.cameraAspect) ?? 0
    },
    cameraAspect() {
      return aspectRatioOf(this.camera)
    },
    /** 绑定有效：有 id 且物体还在。 */
    targetBindingAlive() {
      return Boolean(this.camera?.targetObjectId && this.targetBoundObject)
    },
    /**
     * 绑定了 id 但物体不在了。
     *
     * 必须与"未绑定"区分开：前者要给用户一个明确的清除入口，
     * 否则用户只会看到"看向"的数字在跳，联想不到是绑定。
     */
    targetBindingDangling() {
      return Boolean(this.camera?.targetObjectId && !this.targetBoundObject)
    },
    targetBindingName() {
      return this.targetBoundObject?.name ?? ''
    },
    /**
     * 看向绑定是否**实际生效**（有引用且开关打开）。
     *
     * 缺省视为启用：v14 及更早的工程没有 `lookAtEnabled` 字段。
     */
    lookAtEnabled() {
      return Boolean(this.camera?.targetObjectId) && this.camera.lookAtEnabled !== false
    },
    lookAtEnabledHint() {
      if (!this.camera?.targetObjectId) return '先绑定一个物体'
      if (this.targetBindingDangling) return '绑定的物体已不存在'
      return this.lookAtEnabled
        ? '关闭后相机改用下方固定坐标，绑定关系保留'
        : '打开后相机重新锁定该物体'
    },
    title() {
      if (this.target === 'light') return '灯光属性'
      if (this.target === 'camera') return '摄影机'
      return '物体属性'
    },
    tabs() {
      return [
        { id: 'props', label: '属性' },
        { id: 'notes', label: '说明' }
      ]
    },
    kindLabel() {
      return this.object ? KIND_LABELS[this.object.kind] || this.object.kind : ''
    },
    lightKindLabel() {
      return this.light ? this.lightKinds[this.light.kind] || this.light.kind : ''
    },
    /** 当前物体的节点列表（附带索引，方便 v-for 与事件回传）。 */
    pathNodes() {
      const nodes = this.object?.kind === 'path' ? this.object.pathNodes : null
      if (!Array.isArray(nodes)) return []
      return nodes.map((node, index) => ({ ...node, index }))
    },
    /**
     * 每个节点会被分配到时间轴的哪一刻。
     *
     * 与 core/nav-path.js 的 pathNodeTimes 是同一套规则，
     * 但这里只用局部坐标算比例——世界坐标的平移不改变各段比例，
     * 所以结果完全一致，且不必关心父级的 position。
     */
    nodeTimes() {
      const nodes = this.pathNodes
      if (nodes.length === 0) return []
      if (nodes.length === 1) return [0]
      const lengths = []
      for (let index = 1; index < nodes.length; index += 1) {
        lengths.push(
          Math.hypot(
            nodes[index].x - nodes[index - 1].x,
            nodes[index].y - nodes[index - 1].y,
            nodes[index].z - nodes[index - 1].z
          )
        )
      }
      const total = lengths.reduce((sum, length) => sum + length, 0)
      const duration = Math.max(this.timelineDuration, 0)
      if (total <= 1e-6) {
        return nodes.map((_, index) => (duration / (nodes.length - 1)) * index)
      }
      const times = [0]
      let travelled = 0
      for (const length of lengths) {
        travelled += length
        times.push((travelled / total) * duration)
      }
      return times
    },
    bindingPathId() {
      return this.object?.pathBinding?.pathId ?? ''
    },
    transformDriven() {
      return this.objectKeyframeCount > 0 || Boolean(this.object?.pathBinding)
    }
  },

  methods: {
    /** 读某个关节某个轴当前的角度（没有数据时按 0，与中立姿势一致）。 */
    jointAngle(jointId, axis) {
      return this.object?.mannequin?.pose?.[jointId]?.[axis] ?? 0
    },
    /** 动作下拉框的当前值；`presetId` 为 null 时选「自定义姿势」。 */
    presetValue() {
      return this.object?.mannequin?.presetId || ''
    },
    /** 该关节是否被手动调整过（手动过的会覆盖动作预设）。 */
    isManuallyPosed(jointId) {
      return (this.object?.mannequin?.manualJoints ?? []).includes(jointId)
    },
    /**
     * 限位上下界相同（如膝盖的 Y/Z 是 [0,0]）时滑块没有意义，
     * 禁用掉而不是给一根拖不动的滑块——否则用户会以为界面坏了。
     */
    isAxisLocked(joint, axis) {
      const limits = joint.limits[axis]
      return limits[0] === limits[1]
    },
    changeJoint(jointId, axis, value) {
      this.$emit('update-joint-angle', {
        id: this.object.id,
        jointId,
        axis,
        value: Number(value)
      })
    },
    /** 保存当前整套关节角度为库条目。名字净化与默认名由 core/mannequin.js 决定。 */
    savePose() {
      this.$emit('save-pose', { id: this.object.id, name: this.poseName })
      // 保存后清空输入框：下一次保存通常是另一个姿势，留着旧名字容易误覆盖。
      this.poseName = ''
    },
    applyPoseEntry(entry) {
      this.$emit('apply-library-pose', { id: this.object.id, entryId: entry.id })
    },
    updatePoseEntry(entry) {
      this.$emit('update-library-pose', { id: this.object.id, entryId: entry.id })
    },
    deletePoseEntry(entry) {
      this.$emit('delete-library-pose', { id: this.object.id, entryId: entry.id })
    },
    /** 只给一个关节打帧（`jointIds: [id]` 走通道粒度的路径）。 */
    keyframeJoint(jointId) {
      this.$emit('keyframe-pose', { id: this.object.id, jointIds: [jointId] })
    },
    round(value) {
      return Math.round(value * 100) / 100
    },
    clamp(value, min, max) {
      if (!Number.isFinite(value)) return min
      return Math.min(Math.max(value, min), max)
    },
    value(event) {
      return event.target.value
    },
    patch(update) {
      if (!this.object) return
      this.$emit('update-object', { id: this.object.id, update })
    },
    patchVector(key, axis, event) {
      if (!this.object) return
      const number = Number(event.target.value)
      if (!Number.isFinite(number)) return
      const base = key === 'size' ? Math.max(number, 0.1) : number
      this.$emit('update-object', {
        id: this.object.id,
        update: { [key]: { ...this.object[key], [axis]: base } }
      })
    },
    patchLight(update) {
      if (!this.light) return
      this.$emit('update-light', { id: this.light.id, update })
    },
    patchLightVector(key, axis, event) {
      if (!this.light) return
      const number = Number(event.target.value)
      if (!Number.isFinite(number)) return
      this.$emit('update-light', {
        id: this.light.id,
        update: { [key]: { ...this.light[key], [axis]: number } }
      })
    },
    patchCameraVector(key, axis, event) {
      const number = Number(event.target.value)
      if (!Number.isFinite(number)) return
      this.$emit('update-camera', { [key]: { ...this.camera[key], [axis]: number } })
    },
    preset(event) {
      const presetId = event.target.value
      // 空值是上面那个「自定义姿势」占位项，不是可应用的动作。
      if (!presetId) return
      this.$emit('apply-preset', { id: this.object.id, presetId })
    },
    isAspect(preset) {
      return this.camera.aspectWidth === preset.width && this.camera.aspectHeight === preset.height
    },
    /**
     * 切换画幅。
     *
     * 只上报画幅本身，**视场角的换算由 `Editor.updateCamera` 负责**——
     * 那是相机的唯一写入口，放在那里 AI 命令 / 撤销重做 / 载入都会受益；
     * 放在这个按钮里就只有点按钮这条路是对的。
     */
    applyAspect(preset) {
      this.$emit('update-camera', { aspectWidth: preset.width, aspectHeight: preset.height })
    },
    /** 打开全景图文件选择框。 */
    pickPanorama() {
      this.$refs.panoramaInput?.click()
    },
    /** 选中文件后交给父组件上传（面板不碰网络，见 docs/AI_DEV_GUIDE.md 的分层约定）。 */
    handlePanoramaFile(event) {
      const file = event.target.files?.[0]
      // 必须清空 value：否则连续选同一个文件不会再触发 change。
      event.target.value = ''
      if (!file) return
      this.$emit('upload-panorama', file)
    },
    /** 改背景参数（旋转 / 亮度 / 是否参与光照）。 */
    patchBackground(patch) {
      this.$emit('update-background', patch)
    },
    formatTime(value) {
      return `${(Math.max(Number(value) || 0, 0)).toFixed(2)}s`
    },
    /** 绑定 / 解绑导航线。解绑时同时清掉全部绑定字段。 */
    bindPath(event) {
      if (!this.object) return
      const pathId = event.target.value
      this.$emit('path-bind', { id: this.object.id, pathId: pathId || null })
    },
    patchBinding(update) {
      if (!this.object?.pathBinding) return
      this.$emit('update-object', {
        id: this.object.id,
        update: { pathBinding: { ...this.object.pathBinding, ...update } }
      })
    },
    removeSelectedNode() {
      if (!this.object || this.selectedNodeIndex === null) return
      this.$emit('path-remove-node', { id: this.object.id, index: this.selectedNodeIndex })
    },

    /**
     * 改焦距 → 换算成视场角写回。
     *
     * 项目里焦距**不是独立存储的参数**，只存 `fovDegrees`；焦距是界面上的
     * 另一种输入方式。存两份必然出现"改了 fov、焦距显示不同步"的漂移。
     */
    patchFocalLength(event) {
      const focal = Number(event.target.value)
      const fov = fovDegreesFromFocalLength(focal, this.cameraAspect)
      if (!Number.isFinite(fov)) return
      this.$emit('update-camera', { fovDegrees: clampFovDegrees(fov) })
    },

    /** 焦段预设 → 该画幅下的视场角。 */
    fovForFocal(focalMm) {
      const fov = fovDegreesFromFocalLength(focalMm, this.cameraAspect)
      return clampFovDegrees(fov)
    },

    /**
     * 把物体拖到"看向"行上 → 绑定相机 target。
     * 数据从 `dataTransfer` 里读物体 id，而不是靠"当前选中项"——
     * 拖放期间选中项可能已经变了，用选中项会在边界情况下绑错物体。
     */
    handleTargetDrop(event) {
      this.targetDropActive = false
      const objectId = event.dataTransfer?.getData('text/x-object-id')
      if (!objectId) return
      if (!this.objects.some((object) => object.id === objectId)) return
      this.$emit('bind-camera-target', objectId)
    }
  }
}
</script>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 58%;
}

.inspector__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  font-weight: 600;
  flex: none;
}

.tabs {
  display: flex;
  gap: 2px;
}

.tab {
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}

.tab.is-active {
  background: var(--bg-3);
  color: var(--text-0);
}

.inspector__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.inspector__actions {
  display: flex;
  gap: 6px;
}

.inspector__actions .btn {
  flex: 1;
}

.btn-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.btn.is-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.field--top {
  align-items: flex-start;
  margin-top: 8px;
}

.meta-line {
  margin: 0 0 4px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
}

.drive-notice {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--warn, #e0a14a) 45%, var(--line));
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn, #e0a14a) 12%, transparent);
}

.drive-notice p {
  margin: 0;
  color: var(--text-1, var(--text-0));
  font-size: 11px;
  line-height: 1.55;
}

.drive-notice__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

/* 导航线节点序号：固定宽度的方框，让数字列对齐。 */
.node-index {
  display: grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 18px;
  border: 1px solid var(--accent);
  border-radius: 2px;
  color: var(--accent-strong);
  font-size: 10px;
}

.btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
</style>
