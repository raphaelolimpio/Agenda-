(function () {
    let spaceId;
    let savedPublicSlug = '';
    const status = document.getElementById('vitrineStatus');
    const failedImagePreviews = new Set();
    const colorFields = [
        { picker: 'vitrineCorPrimariaPicker', input: 'vitrineCorPrimaria', property: 'cor_primaria' },
        { picker: 'vitrineCorDestaquePicker', input: 'vitrineCorDestaque', property: 'cor_destaque' },
        { picker: 'vitrineCorFundoPicker', input: 'vitrineCorFundo', property: 'cor_fundo' }
    ];

    function setStatus(message, state) {
        status.textContent = message;
        status.dataset.state = state || '';
    }

    function slugifyStoreName(name) {
        const base = String(name || 'loja')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 44)
            .replace(/-+$/g, '') || 'loja';
        return `${base}-${spaceId}`;
    }

    function updatePublicAddress() {
        const slug = document.getElementById('vitrineSlug').value.trim().toLowerCase();
        const isValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 60;
        const url = isValid ? `${window.location.origin}/${slug}` : '';
        document.getElementById('vitrineUrlPublica').value = url;
        const link = document.getElementById('linkUrlPublica');
        if (savedPublicSlug) {
            link.href = `/${encodeURIComponent(savedPublicSlug)}`;
            link.textContent = slug === savedPublicSlug
                ? 'Abrir endereço publicado'
                : 'Abrir endereço atualmente publicado (salve para ativar o novo)';
        } else {
            link.removeAttribute('href');
            link.textContent = isValid ? 'Salve as configurações para publicar este endereço' : 'Informe um endereço válido para a loja';
        }
    }

    function updateImagePreview(elementId, url) {
        const image = document.getElementById(elementId);
        const warning = document.getElementById('previewImagemAviso');
        const imageUrl = AppApi.getImageUrl(url);
        const updateWarning = () => {
            warning.textContent = failedImagePreviews.size
                ? 'Não foi possível carregar uma imagem. Confira se o arquivo no Google Drive está compartilhado com “Qualquer pessoa com o link”.'
                : '';
            warning.classList.toggle('hidden', failedImagePreviews.size === 0);
        };
        image.dataset.previewUrl = imageUrl;
        if (!imageUrl) {
            failedImagePreviews.delete(elementId);
            image.removeAttribute('src');
            image.classList.add('hidden');
            updateWarning();
            return;
        }
        image.onerror = () => {
            if (image.dataset.previewUrl !== imageUrl) return;
            failedImagePreviews.add(elementId);
            image.classList.add('hidden');
            updateWarning();
        };
        image.onload = () => {
            if (image.dataset.previewUrl !== imageUrl) return;
            failedImagePreviews.delete(elementId);
            updateWarning();
        };
        failedImagePreviews.delete(elementId);
        image.classList.remove('hidden');
        image.src = imageUrl;
        updateWarning();
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
            public_slug: document.getElementById('vitrineSlug').value.trim().toLowerCase(),
            instagram_handle: document.getElementById('vitrineInstagram').value.trim(),
            facebook_url: document.getElementById('vitrineFacebook').value.trim(),
            tiktok_url: document.getElementById('vitrineTikTok').value.trim(),
            youtube_url: document.getElementById('vitrineYouTube').value.trim(),
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
        updateImagePreview('previewBanner', settings.banner_url);
        updateImagePreview('previewLogo', settings.logo_url);
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
    document.getElementById('vitrineSlug').addEventListener('input', updatePublicAddress);
    document.getElementById('linkUrlPublica').addEventListener('click', (event) => {
        if (!savedPublicSlug) event.preventDefault();
    });

    async function loadVitrine() {
        setStatus('Carregando configurações...', '');
        try {
            const settings = await AppApi.request(`/espacos/${encodeURIComponent(spaceId)}/vitrine`);
            selectSegment(settings.segmento || 'salao');
            document.getElementById('vitrineBanner').value = settings.banner_url || '';
            document.getElementById('vitrineLogo').value = settings.logo_url || '';
            document.getElementById('vitrineDesc').value = settings.descricao || '';
            document.getElementById('perfilNomeLoja').value = settings.nome || document.getElementById('perfilNomeLoja').value;
            savedPublicSlug = settings.public_slug || '';
            document.getElementById('vitrineSlug').value = savedPublicSlug || slugifyStoreName(settings.nome);
            document.getElementById('vitrineInstagram').value = settings.instagram_handle || '';
            document.getElementById('vitrineFacebook').value = settings.facebook_url || '';
            document.getElementById('vitrineTikTok').value = settings.tiktok_url || '';
            document.getElementById('vitrineYouTube').value = settings.youtube_url || '';
            updatePublicAddress();
            document.getElementById('vitrineUrlPrefixo').textContent = `${window.location.host}/`;
            const menuAvatar = document.getElementById('ownerMenuAvatar');
            const menuAvatarFallback = document.getElementById('ownerMenuAvatarFallback');
            const logoUrl = AppApi.getImageUrl(settings.logo_url);
            if (logoUrl) {
                menuAvatar.src = logoUrl;
                menuAvatar.hidden = false;
                menuAvatarFallback.hidden = true;
                menuAvatar.onerror = () => {
                    menuAvatar.hidden = true;
                    menuAvatarFallback.hidden = false;
                };
            } else {
                menuAvatar.removeAttribute('src');
                menuAvatar.hidden = true;
                menuAvatarFallback.hidden = false;
            }

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
        const slug = payload.public_slug;
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) {
            setStatus('Use um endereço com letras minúsculas, números e hífens, sem espaços ou acentos.', 'error');
            return;
        }

        button.disabled = true;
        setStatus('Salvando identidade visual...', '');
        const saveController = new AbortController();
        const saveTimeout = setTimeout(() => saveController.abort(), 20000);
        try {
            const savedSettings = await AppApi.request(`/espacos/${encodeURIComponent(spaceId)}/vitrine`, {
                method: 'PUT',
                body: JSON.stringify(payload),
                signal: saveController.signal
            });
            savedPublicSlug = savedSettings.public_slug || slug;
            updatePublicAddress();
            updatePreview();
            setStatus('Vitrine salva. O endereço exclusivo e as informações já estão disponíveis para os clientes.', 'success');
        } catch (error) {
            const message = error.name === 'AbortError'
                ? 'O salvamento demorou mais de 20 segundos. Verifique a conexão e tente novamente.'
                : error.status === 401
                    ? 'Sua sessão expirou ou não está ativa neste endereço. Entre novamente como dono e tente salvar.'
                    : error.message;
            setStatus(message, 'error');
        } finally {
            clearTimeout(saveTimeout);
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
            document.getElementById('ownerMenuName').textContent = account.store_name;
            spaceId = String(account.space_id);
            AppApi.setSpaceId(spaceId);
            document.getElementById('linkVisualizarVitrine').href = `vitrine.html?loja=${encodeURIComponent(spaceId)}&origem=painel`;
            document.getElementById('vitrineUrlPrefixo').textContent = `${window.location.host}/`;
            await loadVitrine();
        } catch (error) {
            setStatus(error.message, 'error');
        } finally {
            saveButton.disabled = !spaceId;
        }
    }

    initialize();
})();
