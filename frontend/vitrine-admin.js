(function () {
    let spaceId;
    const status = document.getElementById('vitrineStatus');
    const colorFields = [
        { picker: 'vitrineCorPrimariaPicker', input: 'vitrineCorPrimaria', property: 'cor_primaria' },
        { picker: 'vitrineCorDestaquePicker', input: 'vitrineCorDestaque', property: 'cor_destaque' },
        { picker: 'vitrineCorFundoPicker', input: 'vitrineCorFundo', property: 'cor_fundo' }
    ];

    function setStatus(message, state) {
        status.textContent = message;
        status.dataset.state = state || '';
    }

    function selectSegment(value) {
        const select = document.getElementById('vitrineSegmento');
        const normalized = String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const knownSegment = normalized.includes('barbear') ? 'barbearia'
            : normalized.includes('estet') ? 'estetica'
                : normalized.includes('saude') || normalized.includes('fisio') ? 'saude'
                    : normalized.includes('tatu') ? 'tatuagem'
                        : normalized.includes('salao') || normalized.includes('beleza') ? 'salao'
                            : value;

        if (![...select.options].some((option) => option.value === knownSegment)) {
            const option = document.createElement('option');
            option.value = knownSegment || 'outros';
            option.textContent = knownSegment || 'Outro segmento';
            select.appendChild(option);
        }
        select.value = knownSegment || 'outros';
    }

    function readForm() {
        return {
            segmento: document.getElementById('vitrineSegmento').value,
            banner_url: document.getElementById('vitrineBanner').value.trim(),
            logo_url: document.getElementById('vitrineLogo').value.trim(),
            descricao: document.getElementById('vitrineDesc').value.trim(),
            cor_primaria: document.getElementById('vitrineCorPrimaria').value.trim(),
            cor_destaque: document.getElementById('vitrineCorDestaque').value.trim(),
            cor_fundo: document.getElementById('vitrineCorFundo').value.trim()
        };
    }

    function updatePreview() {
        const settings = readForm();
        const segment = document.getElementById('vitrineSegmento');
        const name = document.getElementById('perfilNomeLoja').value.trim() || 'Seu estabelecimento';

        AppApi.applyBrandTheme(settings);
        document.getElementById('previewNomeLoja').textContent = name;
        document.getElementById('previewSegmento').textContent = segment.options[segment.selectedIndex]?.text || 'Outro segmento';
        document.getElementById('previewDescricao').textContent = settings.descricao || 'Sua descrição aparece aqui para apresentar seu negócio aos clientes.';
    }

    colorFields.forEach(({ picker, input }) => {
        const pickerElement = document.getElementById(picker);
        const textElement = document.getElementById(input);
        if (/^#[\da-f]{6}$/i.test(textElement.value)) pickerElement.value = textElement.value;

        pickerElement.addEventListener('input', () => {
            textElement.value = pickerElement.value.toUpperCase();
            updatePreview();
        });

        textElement.addEventListener('input', () => {
            if (/^#[\da-f]{6}$/i.test(textElement.value)) {
                pickerElement.value = textElement.value;
                updatePreview();
            }
        });
    });

    ['vitrineSegmento', 'vitrineDesc'].forEach((id) => {
        document.getElementById(id).addEventListener('input', updatePreview);
        document.getElementById(id).addEventListener('change', updatePreview);
    });
    document.getElementById('perfilNomeLoja').addEventListener('input', updatePreview);

    async function loadVitrine() {
        setStatus('Carregando configurações...', '');
        try {
            const settings = await AppApi.request(`/espacos/${encodeURIComponent(spaceId)}/vitrine`);
            selectSegment(settings.segmento || 'salao');
            document.getElementById('vitrineBanner').value = settings.banner_url || '';
            document.getElementById('vitrineLogo').value = settings.logo_url || '';
            document.getElementById('vitrineDesc').value = settings.descricao || '';
            document.getElementById('perfilNomeLoja').value = settings.nome || document.getElementById('perfilNomeLoja').value;

            colorFields.forEach(({ picker, input, property }) => {
                const color = settings[property] || document.getElementById(input).value;
                document.getElementById(input).value = color;
                document.getElementById(picker).value = color;
            });

            updatePreview();
            setStatus('Configurações carregadas.', 'success');
        } catch (error) {
            setStatus(error.message, 'error');
        }
    }

    document.getElementById('salvarVitrineBtn').addEventListener('click', async () => {
        const button = document.getElementById('salvarVitrineBtn');
        const payload = readForm();
        if (!spaceId) {
            setStatus('Não foi possível identificar o estabelecimento desta conta.', 'error');
            return;
        }
        if (colorFields.some(({ input }) => !/^#[\da-f]{6}$/i.test(document.getElementById(input).value))) {
            setStatus('Use cores hexadecimais válidas no formato #RRGGBB.', 'error');
            return;
        }

        button.disabled = true;
        setStatus('Salvando identidade visual...', '');
        try {
            await AppApi.request(`/espacos/${encodeURIComponent(spaceId)}/vitrine`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            updatePreview();
            setStatus('Vitrine salva. As cores e informações já estão disponíveis para os clientes.', 'success');
        } catch (error) {
            setStatus(error.message, 'error');
        } finally {
            button.disabled = false;
        }
    });

    async function initialize() {
        const saveButton = document.getElementById('salvarVitrineBtn');
        saveButton.disabled = true;
        try {
            const { account, subscription } = await AppApi.request('/api/saas/me');
            if (!subscription.can_access) {
                window.location.replace('assinatura.html');
                return;
            }
            if (!account.space_id) {
                throw new Error('Esta conta ainda não tem um estabelecimento associado.');
            }
            const storeName = document.getElementById('uiNomeEspaco');
            if (storeName) storeName.textContent = account.store_name;
            spaceId = String(account.space_id);
            AppApi.setSpaceId(spaceId);
            document.getElementById('linkVisualizarVitrine').href = `vitrine.html?loja=${encodeURIComponent(spaceId)}`;
            await loadVitrine();
        } catch (error) {
            setStatus(error.message, 'error');
        } finally {
            saveButton.disabled = !spaceId;
        }
    }

    initialize();
})();
