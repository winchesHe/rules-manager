export type MetricStripItem = {
  label: string
  note?: string
  value: string
}

export function MetricStrip({
  ariaLabel,
  items,
}: {
  ariaLabel: string
  items: MetricStripItem[]
}) {
  if (items.length > 4) {
    throw new Error('MetricStrip supports at most four items')
  }

  return (
    <section
      aria-label={ariaLabel}
      className="grid grid-cols-4 border-y border-border max-lg:grid-cols-2"
      data-metric-count={items.length}
      data-metric-strip="true"
    >
      {items.map((item, index) => (
        <div
          className={`px-5 py-4 ${
            index > 0 ? 'border-l border-border' : ''
          } max-lg:[&:nth-child(3)]:border-l-0 max-lg:[&:nth-child(n+3)]:border-t`}
          key={item.label}
        >
          <span className="block text-xs font-medium text-muted">{item.label}</span>
          <strong className="mt-1 flex items-baseline gap-2 text-lg font-semibold text-foreground">
            {item.value}
            {item.note && (
              <small className="text-xs font-normal text-muted">{item.note}</small>
            )}
          </strong>
        </div>
      ))}
    </section>
  )
}

