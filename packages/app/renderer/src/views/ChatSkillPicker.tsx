import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Switch } from '@heroui/react'
import { Check, Search, SlidersHorizontal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatSkillOption } from './chat-skill-picker-model'
import { filterChatSkills, orderChatSkills } from './chat-skill-picker-model'

interface ChatSkillPickerProps {
  fastMode: boolean
  onFastModeChange: (selected: boolean) => void
  onClose: () => void
  onToggle: (name: string) => void
  recentNames: string[]
  selectedNames: string[]
  skills: ChatSkillOption[]
}

export function ChatSkillPicker({
  fastMode,
  onFastModeChange,
  onClose,
  onToggle,
  recentNames,
  selectedNames,
  skills,
}: ChatSkillPickerProps) {
  const { t } = useTranslation('chat')
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const selectedSet = useMemo(() => new Set(selectedNames), [selectedNames])
  const filtered = useMemo(() => filterChatSkills(skills, query), [query, skills])
  const sections = useMemo(
    () => query.trim() ? { recent: [], all: filtered } : orderChatSkills(filtered, recentNames),
    [filtered, query, recentNames],
  )
  const keyboardItems = useMemo(
    () => [...sections.recent, ...sections.all],
    [sections],
  )

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, keyboardItems.length - 1)))
  }, [keyboardItems.length])

  return (
    <div
      aria-label={t('skillPicker')}
      className="absolute bottom-10 left-0 z-50 flex h-[min(32rem,calc(100vh-8rem))] w-[min(28rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
      data-skill-picker
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{t('skills')}</div>
          <div className="text-[11px] text-muted">{t('skillPickerDescription')}</div>
        </div>
        <Button aria-label={t('closeSkillPicker')} className="size-8 min-h-8 min-w-8" isIconOnly onPress={onClose} size="sm" variant="ghost">
          <X aria-hidden="true" size={15} />
        </Button>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs text-foreground"><SlidersHorizontal size={14} />{t('fastMode')}</span>
        <Switch aria-label={t('fastMode')} isSelected={fastMode} onChange={onFastModeChange}>
          <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
        </Switch>
      </div>

      {selectedNames.length > 0 && (
        <div className="shrink-0 border-b border-border px-4 py-3" data-selected-skills>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('selectedSkills')}</div>
          <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
            {selectedNames.map((name) => (
              <button
                aria-label={t('removeSkill', { name })}
                className="flex items-center gap-1 rounded-full bg-primary-soft px-2 py-1 text-xs text-foreground transition-colors hover:bg-surface-hover"
                key={name}
                onClick={() => onToggle(name)}
                type="button"
              >
                /{name}<X aria-hidden="true" size={12} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="shrink-0 px-3 py-3">
        <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background/40 px-3 focus-within:border-primary/60">
          <Search aria-hidden="true" className="shrink-0 text-muted" size={15} />
          <input
            aria-label={t('searchSkills')}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((current) => Math.min(current + 1, keyboardItems.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((current) => Math.max(0, current - 1))
              } else if (event.key === 'Enter' && keyboardItems[activeIndex]) {
                event.preventDefault()
                onToggle(keyboardItems[activeIndex].name)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            }}
            placeholder={t('searchSkillsPlaceholder')}
            ref={searchRef}
            value={query}
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" role="listbox" aria-multiselectable="true">
        {sections.recent.length > 0 && (
          <SkillSection
            activeIndex={activeIndex}
            indexOffset={0}
            label={t('recentSkills')}
            onToggle={onToggle}
            selectedSet={selectedSet}
            skills={sections.recent}
            sourceLabels={{ provider: t('providerSkill'), shared: t('sharedSkill') }}
          />
        )}
        {sections.all.length > 0 && (
          <SkillSection
            activeIndex={activeIndex}
            indexOffset={sections.recent.length}
            label={query.trim() ? t('searchResults') : t('allSkills')}
            onToggle={onToggle}
            selectedSet={selectedSet}
            skills={sections.all}
            sourceLabels={{ provider: t('providerSkill'), shared: t('sharedSkill') }}
          />
        )}
        {keyboardItems.length === 0 && (
          <div className="grid h-28 place-items-center px-4 text-center text-sm text-muted">{t('noSkillsFound')}</div>
        )}
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between border-t border-border px-4 text-[10px] text-muted">
        <span>{t('skillKeyboardHint')}</span>
        <span>{t('selectedSkillCount', { count: selectedNames.length })}</span>
      </div>
    </div>
  )
}

function SkillSection({
  activeIndex,
  indexOffset,
  label,
  onToggle,
  selectedSet,
  skills,
  sourceLabels,
}: {
  activeIndex: number
  indexOffset: number
  label: string
  onToggle: (name: string) => void
  selectedSet: Set<string>
  skills: ChatSkillOption[]
  sourceLabels: Record<ChatSkillOption['source'], string>
}) {
  return (
    <section className="mb-2">
      <div className="sticky top-0 z-10 bg-surface px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      {skills.map((skill, index) => {
        const selected = selectedSet.has(skill.name)
        const active = activeIndex === indexOffset + index
        return (
          <button
            aria-selected={selected}
            className={`flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors ${active ? 'bg-surface-hover' : 'hover:bg-surface-hover/70'}`}
            key={skill.name}
            onClick={() => onToggle(skill.name)}
            role="option"
            type="button"
          >
            <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${selected ? 'border-success bg-success text-white' : 'border-border'}`}>
              {selected && <Check aria-hidden="true" size={11} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{skill.name}</span>
                <span className="shrink-0 rounded bg-background/60 px-1.5 py-0.5 text-[9px] text-muted">{sourceLabels[skill.source]}</span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted">{skill.description || '—'}</span>
            </span>
          </button>
        )
      })}
    </section>
  )
}
