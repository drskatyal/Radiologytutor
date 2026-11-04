// Native details works without JavaScript; Escape returns focus to its summary.
document.querySelectorAll('.fr-switch details').forEach(menu => {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
});
