(function () {
    function closeMenu(toggle, menu) {
        menu.dataset.open = 'false';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Abrir menu');
    }

    document.querySelectorAll('[data-menu-toggle]').forEach((toggle) => {
        const menu = document.getElementById(toggle.getAttribute('aria-controls'));
        if (!menu) return;

        closeMenu(toggle, menu);
        toggle.addEventListener('click', () => {
            const isOpen = menu.dataset.open === 'true';
            menu.dataset.open = String(!isOpen);
            toggle.setAttribute('aria-expanded', String(!isOpen));
            toggle.setAttribute('aria-label', isOpen ? 'Abrir menu' : 'Fechar menu');
        });

        menu.addEventListener('click', (event) => {
            if (event.target.closest('a, button') && !event.target.closest('select')) {
                closeMenu(toggle, menu);
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeMenu(toggle, menu);
        });

        document.addEventListener('click', (event) => {
            if (!menu.contains(event.target) && !toggle.contains(event.target)) {
                closeMenu(toggle, menu);
            }
        });
    });
})();
