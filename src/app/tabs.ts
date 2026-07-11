/** WAI-ARIA tabs: two panels, keyboard-navigable, hash-linkable (#restore). */
import { $ } from './dom';

export type TabId = 'backup' | 'restore';

export function setupTabs(onChange?: (tab: TabId) => void): void {
  const tabs: TabId[] = ['backup', 'restore'];
  const buttons = tabs.map((t) => $<HTMLButtonElement>(`#tab-${t}`));
  const panels = tabs.map((t) => $(`#panel-${t}`));

  function activate(tab: TabId, focus = false): void {
    tabs.forEach((t, i) => {
      const selected = t === tab;
      buttons[i].setAttribute('aria-selected', String(selected));
      buttons[i].tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
    });
    if (focus) buttons[tabs.indexOf(tab)].focus();
    if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
    onChange?.(tab);
  }

  buttons.forEach((button, i) => {
    button.addEventListener('click', () => activate(tabs[i]));
    button.addEventListener('keydown', (event) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!delta) return;
      event.preventDefault();
      activate(tabs[(i + delta + tabs.length) % tabs.length], true);
    });
  });

  activate(location.hash === '#restore' ? 'restore' : 'backup');
  window.addEventListener('hashchange', () => {
    const target = location.hash === '#restore' ? 'restore' : 'backup';
    activate(target);
  });
}
