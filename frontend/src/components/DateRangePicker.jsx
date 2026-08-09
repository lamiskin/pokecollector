import { useEffect, useRef, useState } from 'react'
import { Calendar, X } from 'lucide-react'
import { format, startOfDay, subDays, startOfMonth, endOfMonth, subMonths, startOfYear, endOfYear } from 'date-fns'
import { useSettings } from '../contexts/SettingsContext'

const toDateKey = (date) => format(date, 'yyyy-MM-dd')

function buildPresets(t) {
  const today = startOfDay(new Date())
  const todayKey = toDateKey(today)
  const lastMonthStart = startOfMonth(subMonths(today, 1))
  return [
    { key: 'today', label: t('dateRange.today'), from: todayKey, to: todayKey },
    { key: 'yesterday', label: t('dateRange.yesterday'), from: toDateKey(subDays(today, 1)), to: toDateKey(subDays(today, 1)) },
    { key: 'last7', label: t('dateRange.last7Days'), from: toDateKey(subDays(today, 6)), to: todayKey },
    { key: 'last30', label: t('dateRange.last30Days'), from: toDateKey(subDays(today, 29)), to: todayKey },
    { key: 'thisMonth', label: t('dateRange.thisMonth'), from: toDateKey(startOfMonth(today)), to: todayKey },
    { key: 'lastMonth', label: t('dateRange.lastMonth'), from: toDateKey(lastMonthStart), to: toDateKey(endOfMonth(lastMonthStart)) },
    { key: 'thisYear', label: t('dateRange.thisYear'), from: toDateKey(startOfYear(today)), to: toDateKey(endOfYear(today)) },
  ]
}

/**
 * A trigger button that opens a popover with quick-range presets (Today,
 * Last 7 Days, This Month, ...) plus two date inputs for a custom from/to
 * range — presets and custom bounds both write the same {from, to} value,
 * so picking a preset and then nudging one edge in the date inputs just works.
 */
export default function DateRangePicker({ from, to, onChange, placeholder }) {
  const { t } = useSettings()
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const presets = buildPresets(t)
  const activePreset = presets.find(p => p.from === from && p.to === to)
  const hasValue = Boolean(from || to)

  const summary = !hasValue
    ? (placeholder || t('dateRange.anyDate'))
    : activePreset
      ? activePreset.label
      : from && to
        ? (from === to ? from : `${from} → ${to}`)
        : from
          ? `${t('dateRange.from')} ${from}`
          : `${t('dateRange.to')} ${to}`

  return (
    <div className="relative" ref={rootRef}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className={`select select-no-arrow text-sm py-1.5 flex items-center gap-1.5 text-left ${hasValue ? 'text-text-primary' : 'text-text-muted'}`}>
        <Calendar size={14} className="text-text-muted flex-shrink-0" />
        <span className="truncate">{summary}</span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-72 max-w-[90vw] card-surface shadow-xl p-3 space-y-3">
          <div className="grid grid-cols-2 gap-1.5">
            {presets.map(p => (
              <button key={p.key} type="button"
                onClick={() => { onChange({ from: p.from, to: p.to }); setOpen(false) }}
                className={`px-2 py-1.5 rounded-lg text-xs font-medium text-left transition-colors ${
                  activePreset?.key === p.key
                    ? 'bg-brand-red text-white'
                    : 'bg-bg-card text-text-secondary hover:text-text-primary border border-border'
                }`}>
                {p.label}
              </button>
            ))}
          </div>

          <div className="pt-2 border-t border-border grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('dateRange.from')}</label>
              <input type="date" value={from || ''} max={to || undefined}
                onChange={(e) => onChange({ from: e.target.value, to })}
                className="input text-sm py-1.5" />
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('dateRange.to')}</label>
              <input type="date" value={to || ''} min={from || undefined}
                onChange={(e) => onChange({ from, to: e.target.value })}
                className="input text-sm py-1.5" />
            </div>
          </div>

          {hasValue && (
            <button type="button" onClick={() => onChange({ from: '', to: '' })}
              className="btn-ghost-sm w-full justify-center">
              <X size={12} /> {t('common.clear')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
