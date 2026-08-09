import { useTranslation } from 'react-i18next'

export function WindowControls() {
  const { t } = useTranslation('navigation')

  return (
    <div aria-label={t('windowControls')} className="window-controls" role="group">
      <button
        aria-label={t('closeWindow')}
        className="window-control window-control--close"
        onClick={() => { void window.api.invoke('window.close') }}
        type="button"
      />
      <button
        aria-label={t('minimizeWindow')}
        className="window-control window-control--minimize"
        onClick={() => { void window.api.invoke('window.minimize') }}
        type="button"
      />
      <button
        aria-label={t('zoomWindow')}
        className="window-control window-control--zoom"
        onClick={() => { void window.api.invoke('window.toggleMaximize') }}
        type="button"
      />
    </div>
  )
}
