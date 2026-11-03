// 设备动作 duration（时长）参数输入：
// 预设快捷下拉（永久/30分钟/…/30天）+ 自定义（数值 + 单位），替代手填秒数。
// 组件值为人类可读时长（"永久"、"3天"、"45分钟"），由后端 prepare_device_params
// 统一转换为设备侧取值（-1 = 永久，否则秒数），存量默认值/历史值（如 "-1"/"259200"）自动归一化显示。
import { CompactSelect } from './ui'
import { inputCls } from './property/FormControls'
import {
  DURATION_PRESETS, DURATION_UNITS, deviceDurationLabel, durationToParts, durationFromParts,
} from '../utils/ticketFlow'

export default function DeviceDurationInput({ value, onChange, disabled }) {
  const label = deviceDurationLabel(value)
  const isPreset = DURATION_PRESETS.includes(label)
  const parts = durationToParts(label) // { permanent, num, unit }
  const setCustom = (patch) => onChange(durationFromParts({ permanent: false, unit: '天', ...parts, ...patch }))
  return (
    <div className="flex gap-2" data-device-duration>
      <div className="w-36 shrink-0">
        <CompactSelect size="lg" block disabled={disabled}
          value={isPreset ? label : (label ? '__custom' : '')}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__custom') {
              // 进入自定义模式：保留已有数值单位，无则给个起点
              onChange(durationFromParts({ permanent: false, num: parts.num || '1', unit: parts.unit || '天' }))
            } else {
              onChange(v) // '' 或预设值
            }
          }}>
          <option value="">请选择</option>
          {DURATION_PRESETS.map((o) => <option key={o} value={o}>{o}</option>)}
          <option value="__custom">自定义…</option>
        </CompactSelect>
      </div>
      {!isPreset && label !== '' && (
        <>
          <input className={inputCls} type="number" min="1" disabled={disabled}
            value={parts.num} placeholder="数值"
            onChange={(e) => setCustom({ num: e.target.value })} />
          <div className="w-24 shrink-0">
            <CompactSelect size="lg" block disabled={disabled} value={parts.unit || '天'}
              onChange={(e) => setCustom({ unit: e.target.value })}>
              {DURATION_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </CompactSelect>
          </div>
        </>
      )}
    </div>
  )
}
