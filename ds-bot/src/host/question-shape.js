export function questionShape(args = {}) {
  const detail = String(args.detail ?? '').trim()
  return {
    question: String(args.question ?? '').trim(),
    ...(detail === '' ? {} : { detail }),
    options: (Array.isArray(args.options) ? args.options : [])
      .map(option => (typeof option === 'string' ? { label: option } : option ?? {}))
      .map(option => ({
        label: String(option.label ?? '').trim(),
        ...(option.description ? { description: String(option.description).trim() } : {}),
      }))
      .filter(option => option.label !== '')
      .slice(0, 6),
    multiSelect: args.multiSelect === true,
    allowCustom: args.allowCustom === true,
  }
}

export function sameQuestion(card, args) {
  const wanted = questionShape(args)
  return card?.question === wanted.question
    && (card?.detail ?? undefined) === (wanted.detail ?? undefined)
    && JSON.stringify(card?.options ?? []) === JSON.stringify(wanted.options)
    && card?.multiSelect === wanted.multiSelect
    && (card?.allowCustom === true) === wanted.allowCustom
}
