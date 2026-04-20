
const { useState, useEffect, useMemo, useCallback } = React;

const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:8080' : 'https://' + window.location.hostname;

/** Sessão admin (token emitido pelo backend); não armazenar senha. */
const ADMIN_TOKEN_STORAGE_KEY = 'atelie_admin_token';

/** Valor do sinal (R$) — manter alinhado a `FIXED_SIGNAL_AMOUNT` em backend/server.js */
const FIXED_SIGNAL_AMOUNT = 30;

const SERVICES = [
    { id: 'limpeza_pele', name: 'Limpeza de Pele', price: 119.90, category: 'Estética Facial', duration: 60 },
    { id: 'dep_intima', name: 'Depilação Íntima Completa', price: 59.90, category: 'Depilação', duration: 60 },
    { id: 'dep_axila', name: 'Depilação Axila', price: 29.90, category: 'Depilação', duration: 60 },
    { id: 'dep_buco', name: 'Depilação Buço', price: 29.90, category: 'Depilação', duration: 60 },
    { id: 'dep_completa', name: 'Depilação Completa', price: 129.90, category: 'Depilação', duration: 60 },
    { id: 'reflexologia', name: 'Reflexologia Podal', price: 89.90, category: 'Bem-Estar', duration: 60 }
];

const formatPrice = (price) => price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const formatCurrencyBRL = (value) => {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

/** Validação básica alinhada ao backend (evita envio óbvio inválido). */
const isValidEmailFormat = (s) => {
    const t = String(s || '').trim().toLowerCase();
    if (!t || t.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
};

const getPaymentTypeLabel = (paymentType) => {
    const t = String(paymentType || '').toLowerCase();
    if (t === 'partial') return 'Sinal';
    if (t === 'full') return 'Integral';
    return '';
};

const getStatusLabel = (status) => {
    switch (status) {
        case 'pending_payment': return 'Aguardando pagamento';
        case 'confirmed': return 'Confirmado';
        case 'cancelled': return 'Cancelado';
        case 'completed': return 'Concluído';
        default: return status ? String(status) : '—';
    }
};

const getStatusColor = (status) => {
    switch (status) {
        case 'pending_payment': return '#d97706';
        case 'confirmed': return '#059669';
        case 'cancelled': return '#dc2626';
        case 'completed': return '#2563eb';
        default: return '#64748b';
    }
};

const toFiniteNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

const getAppointmentPaymentTypeLabel = (app) => {
    const direct = getPaymentTypeLabel(app?.paymentType);
    if (direct) return direct;

    const fromSummary = getPaymentTypeLabel(app?.paymentSummary?.paymentType);
    if (fromSummary) return fromSummary;

    const summaryLabel = String(app?.paymentSummary?.paymentTypeLabel || '').toLowerCase();
    if (summaryLabel.includes('total')) return 'Integral';
    if (summaryLabel.includes('parcial')) return 'Sinal';

    return '';
};

const getAppointmentReceivedAmount = (app) => {
    const paid = toFiniteNumber(app?.paidAmount);
    if (paid != null && paid > 0) return paid;

    const summaryPaid = toFiniteNumber(app?.paymentSummary?.paidAmount);
    if (summaryPaid != null && summaryPaid > 0) return summaryPaid;

    // pending_payment normalmente ainda não tem "recebido"
    if (app?.status === 'pending_payment') return null;

    const charged = toFiniteNumber(app?.amountCharged);
    if (charged != null && charged > 0) return charged;

    return null;
};

const getAppointmentDueNowAmount = (app) => {
    const charged = toFiniteNumber(app?.amountCharged);
    if (charged != null && charged > 0) return charged;

    const summaryCharged = toFiniteNumber(app?.paymentSummary?.amountCharged);
    if (summaryCharged != null && summaryCharged > 0) return summaryCharged;

    return null;
};

const getAppointmentRemainingAmount = (app) => {
    const rem = toFiniteNumber(app?.remainingAmount);
    if (rem != null) return rem;

    const summaryRem = toFiniteNumber(app?.paymentSummary?.remainingAmount);
    if (summaryRem != null) return summaryRem;

    return null;
};

const AppointmentFinanceBlock = ({ app, mode = 'card' }) => {
    const ptLabel = getAppointmentPaymentTypeLabel(app) || '—';
    const dueNow = getAppointmentDueNowAmount(app);
    const received = getAppointmentReceivedAmount(app);
    const remaining = getAppointmentRemainingAmount(app);

    const isPending = app?.status === 'pending_payment';
    const isPaidish = app?.status === 'confirmed' || app?.status === 'completed';

    const pad = mode === 'compact' ? '10px 12px' : '12px 14px';
    const titleSize = mode === 'compact' ? '12px' : '12px';
    const valueSize = mode === 'compact' ? '14px' : '15px';

    const row = (label, value, { emphasize = false, muted = false } = {}) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline' }}>
            <div style={{ fontSize: '12px', color: muted ? '#64748b' : '#334155', fontWeight: 600 }}>{label}</div>
            <div style={{ fontSize: valueSize, fontWeight: emphasize ? 800 : 700, color: emphasize ? '#0f172a' : '#0f172a', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {value}
            </div>
        </div>
    );

    return (
        <div style={{
            marginTop: '10px',
            padding: pad,
            borderRadius: '10px',
            border: '1px solid #e2e8f0',
            background: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)'
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <div style={{ fontSize: titleSize, fontWeight: 900, color: '#0f172a', letterSpacing: '0.2px' }}>Pagamento</div>
                <div style={{
                    fontSize: '11px',
                    fontWeight: 800,
                    padding: '4px 8px',
                    borderRadius: '999px',
                    border: '1px solid #e2e8f0',
                    background: '#fff',
                    color: '#0f172a',
                    whiteSpace: 'nowrap'
                }}>
                    {ptLabel === '—' ? '—' : `Tipo: ${ptLabel}`}
                </div>
            </div>

            <div style={{ display: 'grid', gap: '8px' }}>
                {isPending && row('Valor a pagar agora', formatCurrencyBRL(dueNow), { emphasize: true })}
                {isPaidish && row('Valor recebido', formatCurrencyBRL(received), { emphasize: true })}
                {!isPending && !isPaidish && row('Valor recebido', formatCurrencyBRL(received), { emphasize: false, muted: true })}

                {(() => {
                    const rem = remaining != null ? remaining : 0;
                    if (rem > 0.009) {
                        return row('Saldo restante', formatCurrencyBRL(rem), { emphasize: true });
                    }
                    return null;
                })()}
            </div>
        </div>
    );
};

const getLocalTodayStr = () => {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().split('T')[0];
};

/** Alinhado ao backend: duração de ocupação na grade e intervalo mínimo entre inícios. */
const DEFAULT_APPOINTMENT_DURATION_MIN = 60;
const MIN_START_GAP_MINUTES = 60;

const normalizeSlotTimeLabel = (t) => {
    if (t == null) return null;
    const s = String(t).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const hh = String(m[1]).padStart(2, '0');
    return `${hh}:${m[2]}`;
};

const parseTimeToMinutes = (timeStr) => {
    const n = normalizeSlotTimeLabel(timeStr);
    if (!n) return null;
    const [h, mm] = n.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
    return h * 60 + mm;
};

/**
 * Gera slots da agenda considerando:
 * - ocupação por duração do serviço (SERVICES[].duration),
 * - intervalo mínimo de 1h entre inícios de agendamentos ativos,
 * - bloqueios manuais (blocked_slots).
 */
const generateTimeSlots = (dateString, existingAppointments, blockedSlotsList = []) => {
    if (!dateString) return [];
    
    const dateObj = new Date(dateString + 'T12:00:00');
    const dayOfWeek = dateObj.getDay(); 
    
    const now = new Date();
    const todayStr = getLocalTodayStr();
    const isToday = dateString === todayStr;
    const currentTotalMinutes = now.getHours() * 60 + now.getMinutes();

    let slots = [];
    if (dayOfWeek === 0) return [];
    else if (dayOfWeek === 6) { // Sat
        let hour = 14; let min = 0;
        while (hour < 17 || (hour === 17 && min === 0)) {
            slots.push(`${hour.toString().padStart(2, '0')}:${min === 0 ? '00' : '30'}`);
            min += 30; if (min >= 60) { hour += 1; min = 0; }
        }
    } else { // Mon-Fri
        let hour = 13; let min = 0;
        while (hour < 19 || (hour === 19 && min <= 30)) {
            slots.push(`${hour.toString().padStart(2, '0')}:${min === 0 ? '00' : '30'}`);
            min += 30; if (min >= 60) { hour += 1; min = 0; }
        }
    }

    const blockedSet = new Set(
        (blockedSlotsList || [])
            .filter((b) => b.date === dateString)
            .map((b) => normalizeSlotTimeLabel(b.time))
            .filter(Boolean)
    );

    const activeApps = existingAppointments.filter(
        (app) => app.date === dateString && ['pending_payment', 'confirmed', 'completed'].includes(app.status)
    );

    const bookedIntervals = activeApps
        .map((app) => {
            const startMins = parseTimeToMinutes(app.time);
            if (startMins == null) return null;
            const service = SERVICES.find((s) => s.id === app.serviceId);
            const duration =
                service && typeof service.duration === 'number' ? service.duration : DEFAULT_APPOINTMENT_DURATION_MIN;
            return { start: startMins, end: startMins + duration };
        })
        .filter(Boolean);

    return slots.map((time) => {
        const slotStartMins = parseTimeToMinutes(time);
        const slotEndMins = slotStartMins + 30;
        const isPast = isToday && slotStartMins <= currentTotalMinutes;
        const isBlockedManual = blockedSet.has(time);

        const isOverlapBooked = bookedIntervals.some(
            (booked) => slotStartMins < booked.end && slotEndMins > booked.start
        );

        const tooCloseToStart = activeApps.some((app) => {
            const S = parseTimeToMinutes(app.time);
            if (S == null || slotStartMins == null) return false;
            return Math.abs(slotStartMins - S) < MIN_START_GAP_MINUTES;
        });

        const isBooked = isOverlapBooked || tooCloseToStart;
        const isUnavailable = isPast || isBlockedManual || isBooked;

        return {
            time,
            available: !isUnavailable,
            isPast,
            isBooked,
            isBlockedManual,
            hasAppointmentAtTime: activeApps.some((a) => normalizeSlotTimeLabel(a.time) === time)
        };
    });
};

const Header = ({ setView, view }) => (
    <div className="top-bar">
        <div className="logo" onClick={() => setView('client')} style={{cursor: 'pointer'}}>
            <span className="logo-main">Ateliê da Pele</span>
            <span className="logo-sub">Estética & Bem Estar</span>
        </div>
        <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'flex-end'}}>
            <button className={`btn-admin ${view === 'my_apps' ? 'active' : ''}`} onClick={() => setView('my_apps')}>
                <i className="fas fa-calendar-alt"></i> Meus Agendamentos
            </button>
            <button className={`btn-admin ${view === 'admin' ? 'active' : ''}`} onClick={() => setView('admin')}>
                <i className="fas fa-lock"></i> {view === 'admin' ? 'Painel' : 'Profissional'}
            </button>
        </div>
    </div>
);

const PasswordModal = ({ onSuccess, onCancel }) => {
    const [pwd, setPwd] = useState('');
    const [errorMsg, setErrorMsg] = useState('');
    const [loading, setLoading] = useState(false);

    const submit = async () => {
        setErrorMsg('');
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/admin/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pwd })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setPwd('');
                setErrorMsg(data.error || 'Não foi possível acessar. Tente novamente.');
                return;
            }
            if (!data.token) {
                setErrorMsg('Resposta inválida do servidor.');
                return;
            }
            setPwd('');
            onSuccess(data.token);
        } catch {
            setPwd('');
            setErrorMsg('Falha de conexão. Verifique a internet e tente de novo.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="password-overlay">
            <div className="password-modal">
                <i className="fas fa-shield-alt" style={{fontSize: '40px', color: 'var(--primary-color)', marginBottom: '15px'}}></i>
                <h3 style={{marginBottom: '20px'}}>Administração</h3>
                {errorMsg && <div className="alert alert-error" style={{padding: '8px', marginBottom: '15px', fontSize: '13px'}}>{errorMsg}</div>}
                <input type="password" className="form-control password-input" placeholder="Senha do painel" value={pwd} onChange={e => setPwd(e.target.value)} onKeyDown={e => e.key === 'Enter' && !loading && submit()} autoFocus disabled={loading} />
                <div className="modal-actions"><button className="btn-cancel" onClick={onCancel} disabled={loading}>Voltar</button><button className="btn-submit" style={{flex: 1}} onClick={submit} disabled={loading}>{loading ? 'Validando…' : 'Acessar'}</button></div>
            </div>
        </div>
    );
};

const StatusBadge = ({ status, mode = 'default' }) => {
    const friendly = mode === 'friendly';
    switch (status) {
        case 'pending_payment':
            return (
                <span className="status-badge st-pending">
                    <i className="fas fa-clock"></i>
                    {friendly ? 'Pagamento pendente' : 'Aguardando Pagamento'}
                </span>
            );
        case 'confirmed':
            return (
                <span className="status-badge st-confirmed">
                    <i className="fas fa-check"></i>
                    {friendly ? 'Confirmado (pagamento ok)' : 'Confirmado'}
                </span>
            );
        case 'cancelled':
            return (
                <span className="status-badge st-cancelled">
                    <i className="fas fa-times"></i>
                    {friendly ? 'Cancelado' : 'Cancelado'}
                </span>
            );
        case 'completed':
            return (
                <span className="status-badge st-completed">
                    <i className="fas fa-flag-checkered"></i>
                    {friendly ? 'Concluído' : 'Concluído'}
                </span>
            );
        default: return null;
    }
}

// ============== ÁREA PROFISSIONAL ==============

const AdminArea = ({ appointments, refreshData, clients, config, setConfig, blockedSlots, adminToken, onAdminSessionInvalid }) => {
    const [adminView, setAdminView] = useState('agenda'); // agenda | clientes | relatorio | config
    const [filter, setFilter] = useState('all');
    const [profPhoneInput, setProfPhoneInput] = useState(config.profPhone || '');

    const [reportStartDate, setReportStartDate] = useState('');
    const [reportEndDate, setReportEndDate] = useState('');
    const [reportData, setReportData] = useState(null);
    const [reportLoading, setReportLoading] = useState(false);
    const [reportError, setReportError] = useState('');
    const [blockManageDate, setBlockManageDate] = useState(getLocalTodayStr());
    const [reportLayoutNarrow, setReportLayoutNarrow] = useState(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return false;
        return window.matchMedia('(max-width: 960px)').matches;
    });

    const [clientEditModal, setClientEditModal] = useState(null);
    const [clientEditError, setClientEditError] = useState('');
    const [clientEditSaving, setClientEditSaving] = useState(false);

    const todayStr = getLocalTodayStr();

    const adminFetch = async (url, options = {}) => {
        const headers = { ...(options.headers || {}) };
        if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
        const res = await fetch(url, { ...options, headers });
        if (res.status === 401 && typeof onAdminSessionInvalid === 'function') {
            onAdminSessionInvalid();
        }
        return res;
    };

    const openEditClient = (c) => {
        setClientEditError('');
        setClientEditModal({
            id: c.id,
            name: c.name || '',
            phone: c.phone || '',
            address: c.address || '',
            email: String(c.email || '').trim()
        });
    };

    const saveClientEdit = async () => {
        if (!clientEditModal) return;
        setClientEditError('');
        const em = String(clientEditModal.email || '').trim().toLowerCase();
        if (!isValidEmailFormat(em)) {
            setClientEditError('Informe um e-mail válido.');
            return;
        }
        const cleanPhone = String(clientEditModal.phone || '').replace(/\D/g, '');
        if (!cleanPhone) {
            setClientEditError('Telefone inválido.');
            return;
        }
        if (!(clientEditModal.name || '').trim()) {
            setClientEditError('Nome é obrigatório.');
            return;
        }
        setClientEditSaving(true);
        try {
            const res = await adminFetch(`${API_BASE_URL}/admin/clients/${encodeURIComponent(clientEditModal.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: (clientEditModal.name || '').trim(),
                    phone: cleanPhone,
                    address: (clientEditModal.address || '').trim(),
                    email: em
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setClientEditError(data.error || 'Não foi possível salvar.');
                return;
            }
            setClientEditModal(null);
            await refreshData();
        } catch {
            setClientEditError('Falha de rede ao salvar.');
        } finally {
            setClientEditSaving(false);
        }
    };

    const handleDeleteClientRecord = async (c) => {
        if (!window.confirm(`Remover o cadastro de "${(c.name || '').trim() || 'esta cliente'}"? Esta ação não pode ser desfeita.`)) return;
        try {
            const res = await adminFetch(`${API_BASE_URL}/admin/clients/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                alert(data.error || 'Não foi possível remover.');
                return;
            }
            await refreshData();
        } catch {
            alert('Falha de rede ao remover.');
        }
    };

    useEffect(() => {
        setProfPhoneInput(config.profPhone || '');
    }, [config.profPhone]);

    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const mq = window.matchMedia('(max-width: 960px)');
        const apply = () => setReportLayoutNarrow(!!mq.matches);
        apply();
        if (mq.addEventListener) mq.addEventListener('change', apply);
        else mq.addListener(apply);
        return () => {
            if (mq.removeEventListener) mq.removeEventListener('change', apply);
            else mq.removeListener(apply);
        };
    }, []);

    const handleDelete = async (id) => {
        if(window.confirm('Apagar DEIFINITIVAMENTE? Irreversível.')) {
            try {
                const res = await adminFetch(`${API_BASE_URL}/appointments/${id}`, { method: 'DELETE' });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    alert(data.error || 'Não foi possível apagar.');
                    return;
                }
                refreshData();
            } catch(e) { console.error(e) }
        }
    };

    const handleCancelByAdmin = async (id) => {
        const reason = window.prompt('Motivo do cancelamento (opcional)?');
        if(reason !== null) {
            try {
                const res = await adminFetch(`${API_BASE_URL}/appointments/${id}/cancel`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cancelledBy: 'admin', cancelReason: reason })
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    alert(data.error || 'Não foi possível cancelar.');
                    return;
                }
                refreshData();
            } catch(e) { console.error(e) }
        }
    };

    const saveConfig = () => {
        const newConfig = { ...config, profPhone: profPhoneInput };
        setConfig(newConfig);
        localStorage.setItem('atelie_config', JSON.stringify(newConfig));
        alert('Telefone salvo localmente!');
    };

    const fetchReport = async () => {
        setReportError('');
        setReportData(null);

        if (!reportStartDate || !reportEndDate) {
            setReportError('Informe a data inicial e a data final.');
            return;
        }

        if (reportStartDate > reportEndDate) {
            setReportError('A data inicial não pode ser maior que a final.');
            return;
        }

        setReportLoading(true);
        try {
            const url = `${API_BASE_URL}/admin/report?start=${encodeURIComponent(reportStartDate)}&end=${encodeURIComponent(reportEndDate)}`;
            const res = await adminFetch(url);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Erro ao buscar relatório.');
            setReportData(data);
        } catch (e) {
            setReportError(e.message || 'Erro ao buscar relatório.');
        } finally {
            setReportLoading(false);
        }
    };

    const handleAdminBlockSlot = async (time) => {
        const reason = window.prompt('Motivo do bloqueio (opcional)?');
        if (reason === null) return;
        try {
            const res = await adminFetch(`${API_BASE_URL}/admin/blocked-slots`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: blockManageDate, time, reason: reason || undefined })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                alert(data.error || 'Não foi possível bloquear este horário.');
                return;
            }
            refreshData();
        } catch (e) {
            console.error(e);
            alert('Erro de rede ao bloquear.');
        }
    };

    const handleAdminUnblockSlot = async (slotId) => {
        if (!window.confirm('Remover este bloqueio e liberar o horário?')) return;
        try {
            const res = await adminFetch(`${API_BASE_URL}/admin/blocked-slots/${slotId}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                alert(data.error || 'Não foi possível remover o bloqueio.');
                return;
            }
            refreshData();
        } catch (e) {
            console.error(e);
            alert('Erro de rede ao remover bloqueio.');
        }
    };

    const adminBlockSlots = useMemo(
        () => generateTimeSlots(blockManageDate, appointments, blockedSlots || []),
        [blockManageDate, appointments, blockedSlots]
    );

    let filteredApps = appointments;
    if (filter === 'today') filteredApps = appointments.filter(a => a.date === todayStr);
    else if (filter === 'next') filteredApps = appointments.filter(a => a.date > todayStr);
    
    const sortedApps = [...filteredApps].sort((a, b) => new Date(a.date + 'T' + a.time) - new Date(b.date + 'T' + b.time));

    const reportCardShell = {
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: '12px',
        padding: '14px',
        minWidth: 0,
        flex: '1 1 158px',
        maxWidth: '100%',
        boxShadow: '0 1px 0 rgba(15, 23, 42, 0.04)',
        boxSizing: 'border-box'
    };

    const ReportCard = ({ title, value, hint }) => (
        <div style={reportCardShell}>
            <div style={{fontSize: '12px', color: '#64748b', marginBottom: '6px', lineHeight: 1.35}}>{title}</div>
            <div style={{fontSize: '18px', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.2px', wordBreak: 'break-word'}}>{value}</div>
            {hint && <div style={{fontSize: '12px', color: '#94a3b8', marginTop: '8px', lineHeight: 1.4}}>{hint}</div>}
        </div>
    );

    const buildReportRowModel = (it) => {
        const pt = String(it.paymentType || '').toLowerCase();
        const payLabel = getPaymentTypeLabel(pt) || '—';
        const dateLabel = it.date ? new Date(it.date + 'T12:00:00').toLocaleDateString('pt-BR') : '—';
        const paidRaw = (it.paidAmount != null && it.paidAmount !== '') ? it.paidAmount : null;
        const paidNum = paidRaw == null ? null : Number(paidRaw);
        const paidOk = paidNum != null && Number.isFinite(paidNum) && paidNum > 0;
        const chargedRaw = (it.amountCharged != null && it.amountCharged !== '') ? it.amountCharged : null;
        const chargedNum = chargedRaw == null ? null : Number(chargedRaw);
        const chargedOk = chargedNum != null && Number.isFinite(chargedNum) && chargedNum > 0;
        const received = paidOk ? paidNum : (chargedOk ? chargedNum : null);
        const balRaw = (it.remainingAmount != null && it.remainingAmount !== '') ? it.remainingAmount : null;
        const balNum = balRaw == null ? null : Number(balRaw);
        const balance = balNum != null && Number.isFinite(balNum) && balNum > 0 ? balNum : null;
        const procFromApi = it.procedureTotal != null && it.procedureTotal !== '' ? Number(it.procedureTotal) : null;
        const service = SERVICES.find(s => s.id === it.serviceId);
        const procedureListPrice =
            procFromApi != null && Number.isFinite(procFromApi)
                ? procFromApi
                : (service && typeof service.price === 'number' ? service.price : null);
        return {
            payLabel,
            dateLabel,
            time: it.time || '—',
            received,
            balance,
            capture: it.captureMethod || '—',
            procedureListPrice,
            clientName: it.clientName || '—',
            serviceName: it.serviceName || it.serviceId || '—',
            status: it.status,
            id: it.id
        };
    };

    return (
        <div className="booking-section step-container">
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <h2 className="section-title" style={{margin:0}}>Painel Profissional</h2>
                <button className="refresh-btn" onClick={refreshData} title="Atualizar agora"><i className="fas fa-sync-alt"></i></button>
            </div>
            
            <div className="filter-tabs" style={{marginTop: '20px', borderBottom: '1px solid #eee', paddingBottom: '15px'}}>
                <button className={`tab-btn ${adminView === 'agenda' ? 'active' : ''}`} onClick={() => setAdminView('agenda')}><i className="fas fa-calendar-alt"></i> Agenda Geral</button>
                <button className={`tab-btn ${adminView === 'clientes' ? 'active' : ''}`} onClick={() => setAdminView('clientes')}><i className="fas fa-users"></i> Radar de Clientes</button>
                <button className={`tab-btn ${adminView === 'relatorio' ? 'active' : ''}`} onClick={() => setAdminView('relatorio')}><i className="fas fa-chart-line"></i> Relatório Financeiro</button>
                <button className={`tab-btn ${adminView === 'config' ? 'active' : ''}`} onClick={() => setAdminView('config')}><i className="fas fa-cog"></i> Ajustes</button>
            </div>

            {adminView === 'config' && (
                <div style={{padding: '15px', backgroundColor: '#f9f9f9', borderRadius: '8px', border: '1px solid #eee'}}>
                    <label className="form-label">Telefone da Profissional (Para links do WhatsApp)</label>
                    <div style={{display: 'flex', gap: '10px'}}>
                        <input type="text" className="form-control" value={profPhoneInput} onChange={e => setProfPhoneInput(e.target.value)} placeholder="Ex: 41984928985" style={{maxWidth: '300px'}} />
                        <button className="btn-submit" onClick={saveConfig} style={{width: 'auto', padding: '10px 20px'}}>Salvar</button>
                    </div>
                </div>
            )}

            {adminView === 'agenda' && (
                <>
                    <div className="filter-tabs" style={{marginTop: '5px'}}>
                        <button className={`tab-btn ${filter === 'today' ? 'active' : ''}`} onClick={() => setFilter('today')}>Hoje</button>
                        <button className={`tab-btn ${filter === 'next' ? 'active' : ''}`} onClick={() => setFilter('next')}>Próximos</button>
                        <button className={`tab-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>Todos</button>
                    </div>

                    <div style={{ marginTop: '14px', padding: '14px 16px', borderRadius: '12px', border: '1px solid #e5e7eb', background: '#fafafa' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px', marginBottom: '8px' }}>
                            <div>
                                <div style={{ fontSize: '13px', fontWeight: 800, color: '#0f172a', marginBottom: '6px' }}>Bloquear horários</div>
                                <div style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.4, maxWidth: '520px' }}>
                                    A grade respeita intervalo mínimo de <strong>1 hora</strong> entre agendamentos. Toque em um horário livre para bloquear; em <strong>Bloqueado</strong> para liberar.
                                </div>
                            </div>
                            <div>
                                <label className="form-label" style={{ marginBottom: '6px' }}>Dia</label>
                                <input type="date" className="form-control" value={blockManageDate} onChange={(e) => setBlockManageDate(e.target.value)} />
                            </div>
                        </div>
                        <div className="time-slots" style={{ marginTop: '10px' }}>
                            {adminBlockSlots.map((slot, idx) => {
                                const blockRow = (blockedSlots || []).find(
                                    (b) => b.date === blockManageDate && normalizeSlotTimeLabel(b.time) === slot.time
                                );
                                let label = 'Livre';
                                if (slot.isPast) label = 'Passado';
                                else if (slot.isBlockedManual) label = 'Bloqueado';
                                else if (slot.hasAppointmentAtTime) label = 'Agendado';
                                else if (!slot.available) label = 'Indisponível';

                                let className = 'time-slot';
                                if (slot.isPast) className += ' past-slot';
                                else if (slot.isBlockedManual) className += ' disabled';
                                else if (!slot.available) className += ' disabled';

                                const canTryBlock = !slot.isPast && !slot.isBlockedManual && !slot.hasAppointmentAtTime;

                                return (
                                    <div
                                        key={idx}
                                        className={className}
                                        title={
                                            slot.isBlockedManual
                                                ? 'Clique para desbloquear'
                                                : canTryBlock
                                                  ? 'Clique para bloquear'
                                                  : slot.hasAppointmentAtTime
                                                    ? 'Horário com agendamento'
                                                    : ''
                                        }
                                        style={{
                                            minWidth: '92px',
                                            flexDirection: 'column',
                                            alignItems: 'stretch',
                                            gap: '4px',
                                            padding: '8px 6px',
                                            cursor:
                                                slot.isPast || slot.hasAppointmentAtTime
                                                    ? 'default'
                                                    : slot.isBlockedManual || canTryBlock
                                                      ? 'pointer'
                                                      : 'default',
                                            borderColor: slot.isBlockedManual ? '#c4b5fd' : undefined,
                                            background: slot.isBlockedManual ? '#f5f3ff' : undefined
                                        }}
                                        onClick={() => {
                                            if (slot.isPast || slot.hasAppointmentAtTime) return;
                                            if (slot.isBlockedManual) {
                                                if (blockRow && blockRow.id != null) handleAdminUnblockSlot(blockRow.id);
                                                return;
                                            }
                                            if (canTryBlock) handleAdminBlockSlot(slot.time);
                                        }}
                                    >
                                        <span style={{ fontWeight: 800, fontSize: '14px' }}>{slot.time}</span>
                                        <span
                                            style={{
                                                fontSize: '10px',
                                                fontWeight: 700,
                                                color: slot.isBlockedManual ? '#5b21b6' : slot.hasAppointmentAtTime ? '#0369a1' : '#64748b',
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.3px'
                                            }}
                                        >
                                            {label}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    
                    <div className="appointments-list">
                        {sortedApps.length === 0 ? <div className="empty-state"><i className="fas fa-box-open"></i><p>Nada agendado neste filtro.</p></div> : 
                            sortedApps.map(app => {
                                const service = SERVICES.find(s => s.id === app.serviceId) || {name: 'Serviço Removido'};
                                const dateStr = new Date(app.date + 'T12:00:00').toLocaleDateString('pt-BR');
                                const isCancelled = app.status === 'cancelled';

                                const pt = (app.paymentType || app.paymentSummary?.paymentType || '').toString().toLowerCase();
                                const paymentLabel = getPaymentTypeLabel(pt);

                                const paidRaw = (app.paidAmount ?? app.paymentSummary?.paidAmount);
                                const chargedRaw = (app.amountCharged ?? app.paymentSummary?.amountCharged);
                                const remainingRaw = (app.remainingAmount ?? app.paymentSummary?.remainingAmount);

                                const chargedNum = (chargedRaw === null || chargedRaw === undefined || chargedRaw === '') ? null : Number(chargedRaw);
                                const charged = (chargedNum != null && Number.isFinite(chargedNum)) ? chargedNum : null;

                                const remainingNum = (remainingRaw === null || remainingRaw === undefined || remainingRaw === '') ? null : Number(remainingRaw);
                                const remaining = (remainingNum != null && Number.isFinite(remainingNum) && remainingNum > 0) ? remainingNum : null;

                                const paidNum = (paidRaw === null || paidRaw === undefined || paidRaw === '') ? null : Number(paidRaw);
                                const paid = (paidNum != null && Number.isFinite(paidNum) && paidNum > 0) ? paidNum : null;

                                const showFinance = !!paymentLabel || paid != null || charged != null || remaining != null;

                                return (
                                    <div key={app.id} className="appointment-item" style={isCancelled ? {opacity: 0.6, borderLeft: '4px solid #ef4444'} : {borderLeft: '4px solid var(--primary-color)'}}>
                                        <div className="appointment-info" style={{flex: 1}}>
                                            <div className="appointment-cliente" style={{display:'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap'}}>
                                                <span style={{fontWeight: 700}}>{app.clientName}</span>
                                                <StatusBadge status={app.status} />
                                                <span style={{
                                                    fontSize: '12px',
                                                    fontWeight: 700,
                                                    color: getStatusColor(app.status),
                                                    border: `1px solid ${getStatusColor(app.status)}33`,
                                                    background: `${getStatusColor(app.status)}14`,
                                                    padding: '4px 10px',
                                                    borderRadius: '999px'
                                                }}>
                                                    {getStatusLabel(app.status)}
                                                </span>
                                            </div>
                                            <div className="appointment-details">
                                                <div className="detail-badge"><i className="far fa-clock"></i> {dateStr} às {app.time}</div>
                                                <div className="detail-badge"><i className="fas fa-spa"></i> {service.name}</div>
                                                <div className="detail-badge"><i className="fas fa-phone"></i> {app.clientPhone}</div>
                                            </div>

                                            {showFinance && (
                                                <div style={{
                                                    marginTop: '10px',
                                                    padding: '10px 12px',
                                                    borderRadius: '10px',
                                                    border: '1px solid #e5e7eb',
                                                    background: '#ffffff'
                                                }}>
                                                    {!!paymentLabel && (
                                                        <div style={{fontSize: '13px', color: '#0f172a', marginBottom: '6px'}}>
                                                            <strong>Pagamento:</strong> {paymentLabel}
                                                        </div>
                                                    )}
                                                    <div style={{display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '13px', color: '#334155'}}>
                                                        {paid != null && (
                                                            <div style={{border: '1px solid #e2e8f0', borderRadius: '10px', padding: '8px 10px', background: '#f8fafc'}}>
                                                                <div style={{fontSize: '11px', color: '#64748b', fontWeight: 700}}>Recebido</div>
                                                                <div style={{fontWeight: 800}}>{formatCurrencyBRL(paid)}</div>
                                                            </div>
                                                        )}
                                                        {(charged != null && charged !== '' && paid == null) && (
                                                            <div style={{border: '1px solid #e2e8f0', borderRadius: '10px', padding: '8px 10px', background: '#f8fafc'}}>
                                                                <div style={{fontSize: '11px', color: '#64748b', fontWeight: 700}}>Valor no checkout</div>
                                                                <div style={{fontWeight: 800}}>{formatCurrencyBRL(charged)}</div>
                                                            </div>
                                                        )}
                                                        {(remaining != null && remaining !== '') && (
                                                            <div style={{border: '1px solid #e2e8f0', borderRadius: '10px', padding: '8px 10px', background: '#fff7ed'}}>
                                                                <div style={{fontSize: '11px', color: '#9a3412', fontWeight: 700}}>Saldo restante</div>
                                                                <div style={{fontWeight: 800, color: '#9a3412'}}>{formatCurrencyBRL(remaining)}</div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            )}

                                            {app.location && <div className="obs-text"><strong><i className="fas fa-map-marker-alt"></i> Local:</strong> {app.location}</div>}
                                            {app.notes && <div className="obs-text"><strong>Obs:</strong> {app.notes}</div>}
                                            {isCancelled && app.cancelReason && <div className="obs-text" style={{color: '#ef4444'}}><strong>Motivo:</strong> {app.cancelReason}</div>}
                                        </div>
                                        <div className="appointment-actions" style={{display: 'flex', gap: '8px', flexDirection: 'column'}}>
                                            {!isCancelled && (
                                                <button className="btn-delete" style={{borderColor: '#f59e0b', color: '#f59e0b'}} onClick={() => handleCancelByAdmin(app.id)} title="Cancelar Horário"><i className="fas fa-times"></i></button>
                                            )}
                                            <button className="btn-delete" onClick={() => handleDelete(app.id)} title="Apagar Ocultar Totalmente"><i className="fas fa-trash-alt"></i></button>
                                        </div>
                                    </div>
                                );
                            })
                        }
                    </div>
                </>
            )}

            {adminView === 'clientes' && (
                <div className="appointments-list" style={{marginTop: '15px'}}>
                    {(!clients || clients.length === 0) ? <div className="empty-state"><i className="fas fa-users-slash"></i><p>Nenhuma cliente na base de dados (SQLite/PG).</p></div> : 
                        clients.map(client => (
                            <div key={client.id} className="appointment-item" style={{alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px'}}>
                                <div className="appointment-info" style={{flex: 1, minWidth: '200px'}}>
                                    <div className="appointment-cliente" style={{color: 'var(--primary-color)', fontSize: '1.2rem', marginBottom: '8px'}}><i className="fas fa-user-circle" style={{marginRight: '8px'}}></i> {client.name}</div>
                                    <div className="appointment-details">
                                        <div className="detail-badge"><i className="fab fa-whatsapp"></i> {client.phone}</div>
                                        {client.email && <div className="detail-badge"><i className="fas fa-envelope"></i> {client.email}</div>}
                                        {client.address && <div className="detail-badge"><i className="fas fa-map-marker-alt"></i> {client.address}</div>}
                                    </div>
                                </div>
                                <div className="appointment-actions" style={{display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center'}}>
                                    <a href={`https://wa.me/55${String(client.phone || '').replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" className="btn-cancel" style={{color: '#25D366', borderColor: '#25D366', padding: '8px 16px', display: 'inline-flex', alignItems: 'center', gap: '8px', textDecoration: 'none'}}>
                                        <i className="fab fa-whatsapp" style={{fontSize: '18px'}}></i> Conversar
                                    </a>
                                    <button type="button" className="btn-cancel" onClick={() => openEditClient(client)} title="Editar cadastro" style={{padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px'}}>
                                        <i className="fas fa-pen"></i> Editar
                                    </button>
                                    <button type="button" className="btn-delete" onClick={() => handleDeleteClientRecord(client)} title="Apagar cadastro" style={{padding: '8px 14px'}}>
                                        <i className="fas fa-trash-alt"></i>
                                    </button>
                                </div>
                            </div>
                        ))
                    }
                </div>
            )}

            {adminView === 'relatorio' && (
                <div style={{marginTop: '15px'}}>
                    <div style={{display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px'}}>
                        <div>
                            <h3 className="section-title" style={{margin: 0, fontSize: '20px'}}>Relatório Financeiro</h3>
                            <div style={{fontSize: '13px', color: '#64748b', marginTop: '6px'}}>
                                Consolidação por período (confirmados/concluídos entram nos totais de receita conforme backend).
                            </div>
                        </div>
                        <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end'}}>
                            <div>
                                <label className="form-label" style={{marginBottom: '6px'}}>Data inicial</label>
                                <input type="date" className="form-control" value={reportStartDate} onChange={e => setReportStartDate(e.target.value)} />
                            </div>
                            <div>
                                <label className="form-label" style={{marginBottom: '6px'}}>Data final</label>
                                <input type="date" className="form-control" value={reportEndDate} onChange={e => setReportEndDate(e.target.value)} />
                            </div>
                            <button className="btn-submit" onClick={fetchReport} disabled={reportLoading} style={{padding: '10px 16px'}}>
                                {reportLoading ? 'Buscando...' : 'Buscar'}
                            </button>
                        </div>
                    </div>

                    {!!reportError && (
                        <div style={{marginBottom: '12px', padding: '10px 12px', borderRadius: '10px', border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b', fontSize: '13px'}}>
                            {reportError}
                        </div>
                    )}

                    {reportData?.summary && (
                        <>
                            <div style={{fontSize: '13px', color: '#64748b', marginBottom: '12px'}}>
                                Período: <strong>{new Date(reportStartDate + 'T12:00:00').toLocaleDateString('pt-BR')}</strong> até{' '}
                                <strong>{new Date(reportEndDate + 'T12:00:00').toLocaleDateString('pt-BR')}</strong>
                            </div>

                            <div style={{display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '10px'}}>
                                <ReportCard
                                    title="Total recebido (efetivo)"
                                    value={formatCurrencyBRL(reportData.summary.totalRevenue)}
                                    hint="Somatório do que já entrou (apenas confirmados e concluídos)."
                                />
                                <ReportCard
                                    title="Total em procedimentos"
                                    value={formatCurrencyBRL(reportData.summary.totalExpectedRevenue)}
                                    hint="Soma do valor de tabela dos serviços (confirmados e concluídos)."
                                />
                                <ReportCard
                                    title="Saldo a receber"
                                    value={formatCurrencyBRL(reportData.summary.totalRemainingToReceive)}
                                    hint="Restante em agendamentos parciais já confirmados ou concluídos."
                                />
                            </div>
                            <div style={{display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '14px'}}>
                                <ReportCard title="Sinais recebidos" value={formatCurrencyBRL(reportData.summary.totalPartialReceived)} hint="Parcela recebida em pagamentos parciais." />
                                <ReportCard title="Integrais recebidos" value={formatCurrencyBRL(reportData.summary.totalFullReceived)} hint="Recebido em pagamentos integrais." />
                                <ReportCard title="Agendamentos (período)" value={String(reportData.summary.totalAppointments || 0)} hint="Todos os status no intervalo." />
                                <ReportCard title="Clientes únicos" value={String(reportData.summary.uniqueClients || 0)} />
                            </div>
                        </>
                    )}

                    {reportLayoutNarrow ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            {(!reportData?.items || reportData.items.length === 0) ? (
                                <div style={{ ...reportCardShell, padding: '16px', fontSize: '13px', color: '#64748b' }}>
                                    {reportLoading ? 'Carregando...' : 'Busque um período para carregar o relatório.'}
                                </div>
                            ) : (
                                reportData.items.map((it, idx) => {
                                    const m = buildReportRowModel(it);
                                    return (
                                        <div key={m.id || idx} style={reportCardShell}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
                                                <div style={{ minWidth: 0, flex: 1 }}>
                                                    <div style={{ fontSize: '15px', fontWeight: 800, color: '#0f172a', lineHeight: 1.3, wordBreak: 'break-word' }}>{m.clientName}</div>
                                                    <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px', lineHeight: 1.35, wordBreak: 'break-word' }}>{m.serviceName}</div>
                                                </div>
                                                <span style={{
                                                    flexShrink: 0,
                                                    fontWeight: 700,
                                                    color: getStatusColor(m.status),
                                                    border: `1px solid ${getStatusColor(m.status)}33`,
                                                    background: `${getStatusColor(m.status)}12`,
                                                    padding: '6px 10px',
                                                    borderRadius: '999px',
                                                    fontSize: '11px',
                                                    maxWidth: '46%',
                                                    textAlign: 'center',
                                                    lineHeight: 1.25,
                                                    wordBreak: 'break-word'
                                                }}>
                                                    {getStatusLabel(m.status)}
                                                </span>
                                            </div>
                                            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '10px' }}>
                                                <strong style={{ color: '#334155' }}>{m.dateLabel}</strong> às <strong style={{ color: '#334155' }}>{m.time}</strong>
                                                {m.capture !== '—' && (
                                                    <span style={{ display: 'block', marginTop: '6px', fontSize: '11px' }}>Captura: {m.capture}</span>
                                                )}
                                            </div>
                                            <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px', fontSize: '12px' }}>
                                                <div>
                                                    <div style={{ color: '#94a3b8', fontWeight: 700, fontSize: '11px', marginBottom: '2px' }}>Pagamento</div>
                                                    <div style={{ fontWeight: 700, color: '#0f172a' }}>{m.payLabel}</div>
                                                </div>
                                                <div style={{ textAlign: 'right' }}>
                                                    <div style={{ color: '#94a3b8', fontWeight: 700, fontSize: '11px', marginBottom: '2px' }}>Recebido</div>
                                                    <div style={{ fontWeight: 800, color: '#0f172a' }}>{m.received != null ? formatCurrencyBRL(m.received) : '—'}</div>
                                                </div>
                                                <div>
                                                    <div style={{ color: '#94a3b8', fontWeight: 700, fontSize: '11px', marginBottom: '2px' }}>Saldo</div>
                                                    <div style={{ fontWeight: 800, color: m.balance != null ? '#9a3412' : '#0f172a' }}>{m.balance != null ? formatCurrencyBRL(m.balance) : '—'}</div>
                                                </div>
                                                <div style={{ textAlign: 'right' }}>
                                                    <div style={{ color: '#94a3b8', fontWeight: 700, fontSize: '11px', marginBottom: '2px' }}>Total procedimento</div>
                                                    <div style={{ fontWeight: 800, color: '#0f172a' }}>{m.procedureListPrice != null ? formatCurrencyBRL(m.procedureListPrice) : '—'}</div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    ) : (
                        <div style={{
                            background: '#ffffff',
                            border: '1px solid #e5e7eb',
                            borderRadius: '12px',
                            maxWidth: '100%',
                            boxSizing: 'border-box',
                            overflow: 'hidden'
                        }}>
                            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
                                <colgroup>
                                    <col style={{ width: '18%' }} />
                                    <col style={{ width: '22%' }} />
                                    <col style={{ width: '12%' }} />
                                    <col style={{ width: '13%' }} />
                                    <col style={{ width: '12%' }} />
                                    <col style={{ width: '23%' }} />
                                </colgroup>
                                <thead>
                                    <tr>
                                        {[
                                            { h: 'Cliente', align: 'left' },
                                            { h: 'Serviço', align: 'left' },
                                            { h: 'Quando', align: 'left' },
                                            { h: 'Status', align: 'left' },
                                            { h: 'Valor total procedimento', align: 'right' },
                                            { h: 'Valores', align: 'right' }
                                        ].map(({ h, align }) => (
                                            <th
                                                key={h}
                                                style={{
                                                    position: 'sticky',
                                                    top: 0,
                                                    zIndex: 2,
                                                    background: '#f8fafc',
                                                    color: '#0f172a',
                                                    fontSize: '11px',
                                                    letterSpacing: '0.4px',
                                                    textTransform: 'uppercase',
                                                    padding: '10px 10px',
                                                    borderBottom: '1px solid #e2e8f0',
                                                    textAlign: align,
                                                    whiteSpace: 'normal',
                                                    lineHeight: 1.25,
                                                    wordBreak: 'break-word'
                                                }}
                                            >
                                                {h}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {(!reportData?.items || reportData.items.length === 0) ? (
                                        <tr>
                                            <td colSpan="6" style={{ padding: '14px', fontSize: '13px', color: '#64748b' }}>
                                                {reportLoading ? 'Carregando...' : 'Busque um período para carregar a tabela.'}
                                            </td>
                                        </tr>
                                    ) : reportData.items.map((it, idx) => {
                                        const m = buildReportRowModel(it);
                                        const tdText = {
                                            padding: '10px 10px',
                                            borderBottom: '1px solid #f1f5f9',
                                            fontSize: '13px',
                                            color: '#0f172a',
                                            verticalAlign: 'top',
                                            textAlign: 'left',
                                            whiteSpace: 'normal',
                                            wordBreak: 'break-word',
                                            lineHeight: 1.35
                                        };
                                        const financeLine = (label, value, { emphasize = false } = {}) => (
                                            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', marginTop: label === 'Tipo' ? 0 : '4px' }}>
                                                <span style={{ color: '#64748b', fontWeight: 600 }}>{label}</span>
                                                <span style={{ fontWeight: emphasize ? 800 : 700, color: emphasize ? '#9a3412' : '#0f172a', textAlign: 'right', whiteSpace: 'nowrap' }}>{value}</span>
                                            </div>
                                        );
                                        return (
                                            <tr key={m.id || idx}>
                                                <td style={tdText}>
                                                    <div style={{ fontWeight: 700 }}>{m.clientName}</div>
                                                    {m.capture !== '—' && (
                                                        <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '6px', lineHeight: 1.3, wordBreak: 'break-word' }}>{m.capture}</div>
                                                    )}
                                                </td>
                                                <td style={tdText}>{m.serviceName}</td>
                                                <td style={tdText}>
                                                    <div style={{ fontWeight: 600 }}>{m.dateLabel}</div>
                                                    <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{m.time}</div>
                                                </td>
                                                <td style={tdText}>
                                                    <span style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        fontWeight: 700,
                                                        color: getStatusColor(m.status),
                                                        border: `1px solid ${getStatusColor(m.status)}33`,
                                                        background: `${getStatusColor(m.status)}12`,
                                                        padding: '5px 8px',
                                                        borderRadius: '999px',
                                                        fontSize: '11px',
                                                        lineHeight: 1.2,
                                                        maxWidth: '100%',
                                                        wordBreak: 'break-word',
                                                        whiteSpace: 'normal'
                                                    }}>
                                                        {getStatusLabel(m.status)}
                                                    </span>
                                                </td>
                                                <td style={{ ...tdText, textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>
                                                    {m.procedureListPrice != null ? formatCurrencyBRL(m.procedureListPrice) : '—'}
                                                </td>
                                                <td style={{ ...tdText, textAlign: 'right' }}>
                                                    <div style={{ display: 'inline-block', width: '100%', maxWidth: '220px', marginLeft: 'auto' }}>
                                                        {financeLine('Tipo', m.payLabel)}
                                                        {financeLine('Recebido', m.received != null ? formatCurrencyBRL(m.received) : '—')}
                                                        {financeLine('Saldo', m.balance != null ? formatCurrencyBRL(m.balance) : '—', { emphasize: m.balance != null })}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {clientEditModal && (
                <div className="password-overlay" style={{ zIndex: 10050 }}>
                    <div className="password-modal" style={{ maxWidth: '420px', width: '100%', textAlign: 'left' }}>
                        <h3 style={{ marginBottom: '16px', textAlign: 'center' }}>Editar cliente</h3>
                        <div className="form-group full-width">
                            <label className="form-label">Nome</label>
                            <input type="text" className="form-control" value={clientEditModal.name} onChange={e => setClientEditModal({ ...clientEditModal, name: e.target.value })} />
                        </div>
                        <div className="form-group full-width">
                            <label className="form-label">WhatsApp (somente números)</label>
                            <input type="text" className="form-control" value={clientEditModal.phone} onChange={e => setClientEditModal({ ...clientEditModal, phone: e.target.value })} />
                        </div>
                        <div className="form-group full-width">
                            <label className="form-label">E-mail</label>
                            <input type="email" className="form-control" autoComplete="email" value={clientEditModal.email} onChange={e => setClientEditModal({ ...clientEditModal, email: e.target.value })} />
                        </div>
                        <div className="form-group full-width">
                            <label className="form-label">Endereço</label>
                            <input type="text" className="form-control" value={clientEditModal.address} onChange={e => setClientEditModal({ ...clientEditModal, address: e.target.value })} />
                        </div>
                        {clientEditError && <div className="alert alert-error" style={{ marginBottom: '12px', fontSize: '13px' }}>{clientEditError}</div>}
                        <div className="modal-actions" style={{ marginTop: '8px' }}>
                            <button type="button" className="btn-cancel" onClick={() => { setClientEditModal(null); setClientEditError(''); }} disabled={clientEditSaving}>Cancelar</button>
                            <button type="button" className="btn-submit" style={{ flex: 1 }} onClick={saveClientEdit} disabled={clientEditSaving}>{clientEditSaving ? 'Salvando…' : 'Salvar'}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};


// ============== ÁREA "MEUS AGENDAMENTOS" (CLIENTE LOGADO) ==============

const MyAppointmentsArea = ({ appointments, refreshData, clients, setView }) => {
    const [phoneInput, setPhoneInput] = useState('');
    const [searchedClient, setSearchedClient] = useState(null);
    const [searchAttempted, setSearchAttempted] = useState(false);
    const [loginError, setLoginError] = useState('');

    const handleSearch = () => {
        setLoginError('');
        const clean = String(phoneInput).replace(/\D/g, '');
        if (!clean) {
            setLoginError('Digite o número cadastrado (com DDD).');
            setSearchAttempted(true);
            setSearchedClient(null);
            return;
        }
        const c = clients.find((cl) => cl.phone.replace(/\D/g, '') === clean);
        setSearchAttempted(true);
        if (c) {
            setSearchedClient(c);
            setLoginError('');
        } else {
            setSearchedClient(null);
            setLoginError('Não encontramos este número. Confira o DDD e os dígitos, ou cadastre-se no fluxo principal.');
        }
    };

    const handleNewSearch = () => {
        setSearchedClient(null);
        setSearchAttempted(false);
        setLoginError('');
    };

    const handleCancelAppointment = async (app) => {
        // Validação Frontend (Menos de 2 horas)
        const apTime = new Date(app.date + 'T' + app.time + ':00-03:00').getTime();
        const now = new Date().getTime();
        const diffHours = (apTime - now) / (1000 * 60 * 60);

        if (diffHours < 2) {
            alert('Não é permitido cancelar com menos de 2 horas de antecedência pelo sistema. Por favor, entre em contato via WhatsApp com o profissional.');
            return;
        }

        if(window.confirm('Deseja cancelar o seu horário? A taxa de adiantamento, se paga, seguirá a política de estorno do Ateliê.')) {
            try {
                const req = await fetch(`${API_BASE_URL}/appointments/${app.id}/cancel`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cancelledBy: 'client', cancelReason: 'Cancelado pelo cliente na sua área' })
                });
                const res = await req.json();
                if (req.ok) {
                    refreshData();
                } else {
                    alert(res.error || 'Falha ao cancelar');
                }
            } catch(e) { console.error(e) }
        }
    };

    const simulaPagamento = async (appId) => {
        // Rotina secreta/Mock apenas para testar Webhook enquanto o Pagbank real não vem
        await fetch(`${API_BASE_URL}/webhook/pagbank`, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ appointment_id: appId, payment_status: 'PAID' }) 
        });
        alert('Pagamento processado com sucesso! (MOCK)');
        refreshData();
    }

    const myApps = searchedClient
        ? appointments
            .filter((a) => a.clientId === searchedClient.id)
            .sort((a, b) => new Date(b.date + 'T' + b.time) - new Date(a.date + 'T' + a.time))
        : [];

    return (
        <div className="booking-section step-container">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <button className="btn-admin" onClick={() => setView('client')} style={{ marginBottom: 0 }}>
                    <i className="fas fa-arrow-left"></i> Voltar
                </button>
                {searchedClient && (
                    <button className="refresh-btn" onClick={refreshData} title="Atualizar lista de agendamentos">
                        <i className="fas fa-sync-alt"></i>
                    </button>
                )}
            </div>

            <h2 className="section-title" style={{ marginTop: '16px', marginBottom: '8px' }}>Meus Agendamentos</h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '18px', lineHeight: 1.45 }}>
                Informe o mesmo WhatsApp do cadastro e toque em <strong>Buscar</strong> para ver seus horários.
            </p>

            <div className="form-group" style={{ marginBottom: searchedClient ? '14px' : '8px' }}>
                <label className="form-label">Telefone (WhatsApp)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'stretch' }}>
                    <input
                        type="text"
                        className="form-control"
                        value={phoneInput}
                        onChange={(e) => setPhoneInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                        placeholder="Ex: 11999999999"
                        style={{ flex: '1 1 200px', minWidth: '0' }}
                    />
                    <button
                        type="button"
                        className="btn-admin"
                        onClick={handleSearch}
                        style={{
                            padding: '10px 18px',
                            whiteSpace: 'nowrap',
                            alignSelf: 'stretch',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px'
                        }}
                    >
                        <i className="fas fa-search" style={{ fontSize: '13px', opacity: 0.85 }}></i>
                        Buscar
                    </button>
                </div>
                {loginError && (
                    <div style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '10px', lineHeight: 1.45 }}>
                        {loginError}
                    </div>
                )}
            </div>

            {searchedClient && (
                <>
                    <div
                        style={{
                            marginTop: '4px',
                            marginBottom: '16px',
                            padding: '10px 12px',
                            borderRadius: '10px',
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0'
                        }}
                    >
                        <div style={{ fontSize: '12px', color: '#64748b', letterSpacing: '0.02em' }}>Agendamentos de</div>
                        <div style={{ fontSize: '17px', fontWeight: 650, color: '#0f172a', marginTop: '2px', lineHeight: 1.25 }}>
                            {searchedClient.name}
                        </div>
                        <button
                            type="button"
                            onClick={handleNewSearch}
                            style={{
                                marginTop: '10px',
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                fontSize: '12px',
                                color: 'var(--primary-color)',
                                cursor: 'pointer',
                                textDecoration: 'underline',
                                fontWeight: 600
                            }}
                        >
                            Nova consulta (outro número)
                        </button>
                    </div>
                </>
            )}

            <div className="appointments-list" style={{ marginTop: searchedClient ? '4px' : '8px' }}>
                {!searchedClient && !searchAttempted && (
                    <div style={{ fontSize: '13px', color: '#94a3b8', fontStyle: 'italic', padding: '8px 0 4px' }}>
                        Os agendamentos aparecem aqui depois que você buscar pelo número.
                    </div>
                )}
                {searchedClient ? (
                    myApps.length === 0 ? (
                    <div className="empty-state" style={{ padding: '28px 16px' }}>
                        <i className="fas fa-calendar-plus"></i>
                        <p style={{ maxWidth: '320px', margin: '0 auto', lineHeight: 1.5 }}>
                            Nenhum agendamento encontrado para este número. Quando você reservar um horário, ele aparecerá aqui.
                        </p>
                    </div>
                    ) : (
                    myApps.map((app) => {
                        const service = SERVICES.find(s => s.id === app.serviceId) || {name: 'Serviço'};
                        const dateStr = new Date(app.date + 'T12:00:00').toLocaleDateString('pt-BR');
                        const isPast = new Date(app.date + 'T' + app.time) < new Date();
                        const isCancelled = app.status === 'cancelled';
                        const isPending = app.status === 'pending_payment';
                        const isConfirmed = app.status === 'confirmed';
                        const isCompleted = app.status === 'completed';

                        const payUrl = app.paymentUrl;
                        const hasPayLink = typeof payUrl === 'string' && /^https?:\/\//i.test(payUrl);

                        const remaining = getAppointmentRemainingAmount(app) ?? 0;
                        const isPartial = String(app.paymentType || '').toLowerCase() === 'partial';

                        const statusHint = (() => {
                            if (isCancelled) return 'Este agendamento foi cancelado.';
                            if (isCompleted) return 'Atendimento concluído. Obrigada pela confiança!';
                            if (isConfirmed) return 'Pagamento confirmado — seu horário está garantido.';
                            if (isPending) {
                                return hasPayLink
                                    ? 'Para confirmar de vez, finalize o pagamento agora (você tem até ~15 minutos).'
                                    : 'Estamos preparando seu link de pagamento. Toque em “Atualizar” acima e tente novamente em alguns segundos.';
                            }
                            return '';
                        })();

                        // Verifica se pode cancelar
                        const apTime = new Date(app.date + 'T' + app.time + ':00-03:00').getTime();
                        const canCancel = (apTime - new Date().getTime()) >= (2 * 60 * 60 * 1000); // Faltam 2+ horas

                        const itemLayoutStyle = { flexWrap: 'wrap', gap: '12px', alignItems: 'stretch' };
                        const itemStyle = isCancelled
                            ? { opacity: 0.6, borderLeft: '4px solid #ef4444', ...itemLayoutStyle }
                            : (isPast ? { opacity: 0.8, ...itemLayoutStyle } : { borderLeft: '4px solid var(--primary-color)', ...itemLayoutStyle });
                        
                        return (
                            <div key={app.id} className="appointment-item" style={itemStyle}>
                                <div className="appointment-info" style={{ flex: '1 1 260px', minWidth: '240px' }}>
                                    <div className="appointment-details" style={{ marginBottom: '10px' }}>
                                        <div className="detail-badge"><i className="far fa-clock"></i> {dateStr} às {app.time}</div>
                                        <div className="detail-badge"><i className="fas fa-spa"></i> {service.name}</div>
                                        <StatusBadge status={app.status} mode="friendly" />
                                    </div>

                                    {!!statusHint && (
                                        <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                                            {statusHint}
                                        </div>
                                    )}

                                    {isConfirmed && (
                                        <div style={{
                                            marginTop: '10px',
                                            padding: '10px 12px',
                                            borderRadius: '10px',
                                            border: '1px solid #bbf7d0',
                                            background: '#ecfdf3',
                                            color: '#065f46',
                                            fontSize: '13px',
                                            fontWeight: 700,
                                            display: 'flex',
                                            gap: '10px',
                                            alignItems: 'flex-start'
                                        }}>
                                            <i className="fas fa-circle-check" style={{ marginTop: '2px' }}></i>
                                            <span>Pagamento recebido e horário confirmado.</span>
                                        </div>
                                    )}

                                    <AppointmentFinanceBlock app={app} />

                                    {isPartial && remaining > 0 && (isConfirmed || isCompleted) && (
                                        <div style={{
                                            marginTop: '10px',
                                            padding: '10px 12px',
                                            borderRadius: '10px',
                                            border: '1px solid #e2e8f0',
                                            background: '#f8fafc',
                                            color: '#475569',
                                            fontSize: '12px',
                                            lineHeight: 1.45
                                        }}>
                                            Saldo restante a pagar no atendimento.
                                        </div>
                                    )}

                                    {app.location && <div className="obs-text"><strong>Endereço do Local:</strong> {app.location}</div>}
                                </div>
                                <div className="appointment-actions" style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: '1 1 200px', minWidth: '200px' }}>
                                    {isPending && !isCancelled && !isPast && (
                                        <>
                                            {hasPayLink ? (
                                                <a
                                                    href={payUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="btn-submit pay-btn"
                                                    style={{ padding: '10px', fontSize: '14px', textAlign: 'center', textDecoration: 'none', width: '100%' }}
                                                >
                                                    <i className="fas fa-lock" style={{ marginRight: '8px' }}></i>
                                                    Pagar agora
                                                </a>
                                            ) : (
                                                <div style={{ fontSize: '12px', color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', padding: '10px', borderRadius: '10px' }}>
                                                    Link de pagamento indisponível no momento. Atualize a lista e tente novamente.
                                                </div>
                                            )}
                                            <button className="btn-cancel" onClick={() => simulaPagamento(app.id)} style={{ fontSize: '12px', padding: '8px' }}>
                                                Simular pagamento (teste)
                                            </button>
                                            <div style={{ fontSize: '11px', color: '#64748b', textAlign: 'center', lineHeight: 1.35 }}>
                                                Abre em uma nova aba. Se já pagou, aguarde alguns instantes e atualize — o status muda automaticamente.
                                            </div>
                                        </>
                                    )}
                                    {!isPast && !isCancelled && canCancel && (
                                        <button className="btn-cancel" onClick={() => handleCancelAppointment(app)} title="Cancelar Agendamento" style={{ color: '#ef4444', borderColor: '#ef4444', padding: '8px' }}>
                                            Cancelar agendamento
                                        </button>
                                    )}
                                    {!canCancel && !isPast && !isCancelled && (
                                        <span style={{ fontSize: '11px', color: '#777', textAlign: 'center', lineHeight: 1.35 }}>
                                            Cancelamento indisponível aqui com menos de 2 horas para o horário. Fale com a profissional pelo WhatsApp.
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })
                    )
                ) : null}
            </div>
        </div>
    );
};

// ============== ÁREA NOVO AGENDAMENTO (FLOW PRINCIPAL) ==============

const ClientArea = ({ appointments, refreshData, clients, config, blockedSlots }) => {
    const [step, setStep] = useState(1);
    
    // Step 1
    const [selectedService, setSelectedService] = useState('');
    const [bookingData, setBookingData] = useState({ date: '', time: '', notes: '', location: '' });
    const [availableTimes, setAvailableTimes] = useState([]);
    
    // Step 2
    const [loginPhone, setLoginPhone] = useState('');
    const [loginError, setLoginError] = useState('');
    const [selectedClient, setSelectedClient] = useState(null);
    const [newClient, setNewClient] = useState({ name: '', phone: '', address: '', email: '' });
    const [isCreatingNew, setIsCreatingNew] = useState(false);
    const [newClientFormError, setNewClientFormError] = useState('');

    // E-mail da reserva (obrigatório no agendamento; preenche com cadastro antigo se existir)
    const [clientEmailForBooking, setClientEmailForBooking] = useState('');

    // Step 3 — tipo de pagamento (enviado ao backend; default sinal)
    const [bookingPaymentType, setBookingPaymentType] = useState('partial');
    const [checkedTerms, setCheckedTerms] = useState(false);

    // Step 4
    const [completedAppInfo, setCompletedAppInfo] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [apiError, setApiError] = useState('');

    const todayStr = getLocalTodayStr();

    useEffect(() => {
        if (bookingData.date) {
            setAvailableTimes(generateTimeSlots(bookingData.date, appointments, blockedSlots || []));
            setBookingData(prev => ({...prev, time: ''}));
        } else {
            setAvailableTimes([]);
        }
    }, [bookingData.date, appointments, blockedSlots]);

    useEffect(() => {
        if (selectedClient?.id) {
            setClientEmailForBooking(String(selectedClient.email || '').trim());
        }
    }, [selectedClient?.id]);

    useEffect(() => {
        setCheckedTerms(false);
    }, [bookingPaymentType]);

    const handleCreateClient = async () => {
        setNewClientFormError('');
        if (!newClient.name || !newClient.phone) {
            setNewClientFormError('Nome e telefone são obrigatórios.');
            return;
        }
        if (!isValidEmailFormat(newClient.email)) {
            setNewClientFormError('Informe um e-mail válido. Usaremos para enviar a confirmação após o pagamento.');
            return;
        }
        const cleanPhone = newClient.phone.replace(/\D/g, '');
        
        setIsLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/clients`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: Date.now().toString(),
                    name: newClient.name,
                    phone: cleanPhone,
                    address: newClient.address,
                    email: newClient.email.trim().toLowerCase()
                })
            });
            const data = await res.json();
            if (!res.ok) {
                setNewClientFormError(data.error || 'Não foi possível salvar seu cadastro. Verifique os dados.');
                return;
            }
            setSelectedClient(data);
            setClientEmailForBooking(String(data.email || newClient.email.trim()).toLowerCase());
            setIsCreatingNew(false);
            setStep(3); // Avança pra confirmação dedicada
            refreshData(); // Puxa clients atualizados
        } catch (e) {
            setNewClientFormError('Falha de conexão ao registrar. Tente novamente.');
        }
        setIsLoading(false);
    };

    const handleConfirmBooking = async () => {
        if (!checkedTerms) {
            return alert(
                bookingPaymentType === 'full'
                    ? 'Você precisa aceitar os termos de pagamento do valor total.'
                    : 'Você precisa aceitar os termos de pagamento do sinal.'
            );
        }

        const emailTrim = clientEmailForBooking.trim().toLowerCase();
        if (!isValidEmailFormat(emailTrim)) {
            setApiError('Informe um e-mail válido. Enviaremos a confirmação do agendamento para esse endereço após o pagamento.');
            return;
        }

        setIsLoading(true);
        setApiError('');
        
        try {
            const serviceId = selectedService;
            const serviceObj = SERVICES.find(s=>s.id === serviceId);
            
            const response = await fetch(`${API_BASE_URL}/appointments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    serviceId: serviceId,
                    clientId: selectedClient.id,
                    clientName: selectedClient.name,
                    clientPhone: selectedClient.phone,
                    clientEmail: emailTrim,
                    date: bookingData.date,
                    time: bookingData.time,
                    notes: bookingData.notes,
                    location: bookingData.location,
                    price: serviceObj.price,
                    paymentType: bookingPaymentType === 'full' ? 'full' : 'partial'
                })
            });

            const data = await response.json();
            
            if (!response.ok) {
                if(response.status === 409) {
                    throw new Error('Alguém reservou este mesmo horário há poucos segundos! Por favor, escolha outro.');
                }
                throw new Error(data.error || 'Falha no servidor ao agendar.');
            }

            setCompletedAppInfo({ service: serviceObj, app: data, client: selectedClient });
            refreshData(); // Atualiza tudo do banco (polling state)
            setStep(4);

        } catch (error) {
            setApiError(error.message);
        } finally {
            setIsLoading(false);
        }
    };

    const priceObj = SERVICES.find(s=>s.id === selectedService);
    const signalDisplayBRL = formatPrice(FIXED_SIGNAL_AMOUNT);
    const isBookingFull = bookingPaymentType === 'full';

    const createdApp = completedAppInfo?.app;
    const createdPayUrl = createdApp?.paymentUrl;
    const createdHasPayLink = typeof createdPayUrl === 'string' && /^https?:\/\//i.test(createdPayUrl);
    const createdPaymentTypeLabel = getAppointmentPaymentTypeLabel(createdApp) || 'Sinal';
    const createdDueNow = getAppointmentDueNowAmount(createdApp);
    const createdRemaining = getAppointmentRemainingAmount(createdApp) ?? 0;
    const createdIsPartial = String(createdApp?.paymentType || '').toLowerCase() === 'partial';

    return (
        <div>
            {step === 1 && (
                <div className="booking-section step-container">
                    <h2 className="section-title">O que deseja agendar?</h2>
                    <div className="services-grid">
                        {SERVICES.map(s => (
                            <div key={s.id} className={`service-card ${selectedService === s.id ? 'selected' : ''}`} onClick={() => setSelectedService(s.id)}>
                                <div className="service-card-header">
                                    <h3>{s.name}</h3><i className="fas fa-check-circle service-check"></i>
                                </div>
                                <div style={{fontSize: '13px', color: 'var(--text-muted)'}}>{s.category}</div>
                                <div className="service-price">{formatPrice(s.price)}</div>
                            </div>
                        ))}
                    </div>

                    <form onSubmit={e => { e.preventDefault(); if(selectedService && bookingData.date && bookingData.time) setStep(2); }} className="form-grid" style={{marginTop: '40px'}}>
                        <div className="form-group full-width">
                            <label className="form-label">Data Escolhida *</label>
                            <input type="date" className="form-control" min={todayStr} value={bookingData.date} onChange={e => setBookingData({...bookingData, date: e.target.value})} required />
                        </div>
                        
                        <div className="form-group full-width">
                            <label className="form-label">Horários Ofertados *</label>
                            {!bookingData.date ? <div style={{color: 'var(--text-muted)', fontSize: '14px'}}>Escolha a data acima primeiro.</div> : 
                                availableTimes.length === 0 ? <div style={{color: 'var(--danger)', fontSize: '14px'}}>Nenhum horário livre.</div> : 
                                <div className="time-slots">
                                    {availableTimes.map((slot, idx) => {
                                        let className = "time-slot";
                                        if (slot.isPast) className += " past-slot";
                                        else if (!slot.available) className += " disabled";
                                        if (bookingData.time === slot.time) className += " selected";
                                        return (
                                            <div key={idx} className={className} 
                                                onClick={() => { if(slot.available && !slot.isPast) setBookingData({...bookingData, time: slot.time}); }}
                                            >
                                                {slot.time} {slot.isPast && <i className="fas fa-history" style={{marginLeft: '4px', fontSize: '10px'}}></i>}
                                            </div>
                                        );
                                    })}
                                </div>
                            }
                        </div>

                        <div className="form-group full-width">
                            <label className="form-label">Endereço do Local (Opcional, se a domicílio)</label>
                            <input type="text" className="form-control" placeholder="Rua, Número, Bairro/Complemento" value={bookingData.location} onChange={e => setBookingData({...bookingData, location: e.target.value})} />
                        </div>
                        
                        <div className="form-group full-width">
                            <label className="form-label">Detalhes da Sessão</label>
                            <textarea className="form-control" placeholder="Algo que devemos saber antes?" value={bookingData.notes} onChange={e => setBookingData({...bookingData, notes: e.target.value})}></textarea>
                        </div>

                        <div className="form-group full-width">
                            <button type="submit" className="btn-submit" disabled={!selectedService || !bookingData.date || !bookingData.time}>Prosseguir à Identificação <i className="fas fa-arrow-right"></i></button>
                        </div>
                    </form>
                </div>
            )}

            {step === 2 && (
                <div className="booking-section step-container">
                    <button className="btn-admin" onClick={() => setStep(1)} style={{marginBottom: '20px'}}><i className="fas fa-arrow-left"></i> Voltar Modificar Dia</button>
                    <h2 className="section-title">Sua Identificação</h2>
                    
                    {!isCreatingNew ? (
                        <>
                            <div className="form-group" style={{background: '#f9f9f9', padding: '15px', borderRadius: '8px', border: '1px solid var(--border-color)'}}>
                                <label className="form-label" style={{fontWeight: 600}}>Já sou cliente (Número do seu WhatsApp)</label>
                                <input type="text" className="form-control" placeholder="Ex: 11999999999..." value={loginPhone} onChange={e => setLoginPhone(e.target.value)} />
                                {loginError && <div style={{color: 'var(--danger)', fontSize: '13px', marginTop: '8px'}}>{loginError}</div>}
                                <button className="btn-submit" style={{marginTop: '15px', width: '100%'}} onClick={() => {
                                    const cleanLogin = loginPhone.replace(/\D/g, '');
                                    const c = clients.find(cl => cl.phone.replace(/\D/g, '') === cleanLogin);
                                    if(c) {
                                        setSelectedClient(c); setLoginError('');
                                        setStep(3);
                                    } else {
                                        setLoginError('Número não encontrado. Tente cadastrar logo abaixo.');
                                    }
                                }}>Acessar com meu número</button>
                            </div>
                            
                            <div style={{textAlign: 'center', margin: '20px 0', color: 'var(--text-muted)'}}>ou criar novo</div>
                            <button className="btn-submit" style={{background: 'var(--secondary-color)', color: 'var(--text-dark)', width: '100%'}} onClick={() => setIsCreatingNew(true)}>
                                <i className="fas fa-user-plus"></i> Cadastro de 1 Minuto
                            </button>
                        </>
                    ) : (
                        <div className="form-grid" style={{background: '#f9f9f9', padding: '20px', borderRadius: '8px', border: '1px solid var(--border-color)'}}>
                            <div className="form-group full-width" style={{marginBottom: '5px'}}>
                                <h3 style={{fontSize: '18px', color: 'var(--text-dark)'}}>Novo Perfil</h3>
                                <p style={{fontSize: '13px', color: 'var(--text-muted)'}}>Rapidamente configure seus dados que serão salvos no sistema para agilizar na próxima vez.</p>
                            </div>
                            <div className="form-group full-width"><label className="form-label">Nome Completo *</label><input type="text" className="form-control" value={newClient.name} onChange={e=>setNewClient({...newClient, name: e.target.value})}/></div>
                            <div className="form-group"><label className="form-label">Seu Contato (WhatsApp) *</label><input type="text" className="form-control" placeholder="Apenas Números" value={newClient.phone} onChange={e=>setNewClient({...newClient, phone: e.target.value})}/></div>
                            <div className="form-group full-width"><label className="form-label">E-mail *</label><input type="email" autoComplete="email" className="form-control" placeholder="seu@email.com" value={newClient.email} onChange={e=>setNewClient({...newClient, email: e.target.value})}/><p style={{fontSize: '12px', color: 'var(--text-muted)', margin: '6px 0 0'}}>Para a confirmação após o pagamento.</p></div>
                            <div className="form-group"><label className="form-label">Endereço Residencial</label><input type="text" className="form-control" value={newClient.address} onChange={e=>setNewClient({...newClient, address: e.target.value})}/></div>
                            {newClientFormError && <div className="form-group full-width" style={{color: 'var(--danger)', fontSize: '13px'}}>{newClientFormError}</div>}
                            <div className="form-group full-width" style={{display:'flex', gap:'10px', marginTop: '10px'}}>
                                <button className="btn-cancel" onClick={() => setIsCreatingNew(false)} disabled={isLoading}>Desistir</button>
                                <button className="btn-submit" style={{flex: 1}} onClick={handleCreateClient} disabled={isLoading}>{isLoading ? 'Salvando BD...' : 'Finalizar Perfil'}</button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {step === 3 && selectedClient && (
                <div className="booking-section step-container" style={{textAlign: 'center'}}>
                    <div style={{display: 'flex', justifyContent: 'flex-start', marginBottom: '20px'}}>
                        <button className="btn-admin" onClick={() => setStep(2)}><i className="fas fa-arrow-left"></i> Modificar Identidade</button>
                    </div>
                    
                    <h2 className="section-title" style={{marginBottom: '10px'}}>Confirme seu Horário</h2>
                    <p style={{fontSize: '18px', color: 'var(--text-dark)', marginBottom: '20px'}}>Por favor <strong>{selectedClient.name.split(' ')[0]}</strong>, verifique atentamente.</p>

                    <div style={{background: '#fcfcfc', padding: '25px', borderRadius: '12px', textAlign: 'left', marginBottom: '20px', display: 'inline-block', maxWidth: '400px', width: '100%', border: '1px solid var(--border-color)', boxShadow: '0 2px 8px rgba(0,0,0,0.03)'}}>
                        <div style={{marginBottom: '10px', fontSize: '15px'}}><strong style={{color: 'var(--primary-color)'}}>Serviço (Estética/Epilação):</strong> {priceObj.name}</div>
                        <div style={{marginBottom: '10px', fontSize: '15px'}}><strong style={{color: 'var(--primary-color)'}}>Agendamento para:</strong> {new Date(bookingData.date + 'T12:00:00').toLocaleDateString('pt-BR')} às {bookingData.time}</div>
                        {bookingData.location && <div style={{marginBottom: '10px', fontSize: '14px', fontStyle: 'italic'}}><strong style={{color: 'var(--primary-color)'}}>Em:</strong> {bookingData.location}</div>}
                        <div style={{fontSize: '16px', borderTop: '1px solid #ddd', paddingTop: '10px', marginTop: '15px'}}><strong style={{color: '#00A676'}}>Valor do procedimento:</strong> {formatPrice(priceObj.price)}</div>
                        <div style={{fontSize: '16px', color: '#eab308', fontWeight: 'bold'}}>
                            {isBookingFull ? (
                                <><strong style={{color: '#eab308'}}>Pagamento agora (integral):</strong> {formatPrice(priceObj.price)}</>
                            ) : (
                                <><strong style={{color: '#eab308'}}>Pagamento agora (sinal):</strong> {signalDisplayBRL}</>
                            )}
                        </div>
                    </div>

                    <div className="payment-type-group" style={{ maxWidth: '400px', margin: '0 auto 16px', textAlign: 'left' }}>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-dark)', marginBottom: '8px' }}>Como prefere pagar?</div>
                        <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '14px', marginBottom: '8px' }}>
                            <input type="radio" name="bookingPaymentType" checked={bookingPaymentType === 'partial'} onChange={() => setBookingPaymentType('partial')} style={{ marginTop: '3px' }} />
                            <span>Pagar apenas o sinal ({signalDisplayBRL}) — saldo no dia do atendimento.</span>
                        </label>
                        <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '14px' }}>
                            <input type="radio" name="bookingPaymentType" checked={bookingPaymentType === 'full'} onChange={() => setBookingPaymentType('full')} style={{ marginTop: '3px' }} />
                            <span>Pagar o valor total agora ({formatPrice(priceObj.price)}).</span>
                        </label>
                    </div>

                    <div className="form-group full-width" style={{maxWidth: '400px', margin: '0 auto 16px', textAlign: 'left'}}>
                        <label className="form-label">E-mail para confirmação *</label>
                        <input type="email" autoComplete="email" className="form-control" placeholder="seu@email.com" value={clientEmailForBooking} onChange={e => setClientEmailForBooking(e.target.value)} />
                        <p style={{fontSize: '12px', color: 'var(--text-muted)', margin: '6px 0 0'}}>Enviaremos um resumo amigável assim que o pagamento for confirmado.</p>
                    </div>

                    <div style={{background: '#fff3cd', border: '1px solid #ffeeba', padding: '15px', borderRadius: '8px', maxWidth: '400px', margin: '0 auto 20px', textAlign: 'left'}}>
                        <label style={{display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '14px', color: '#856404'}}>
                            <input type="checkbox" checked={checkedTerms} onChange={e => setCheckedTerms(e.target.checked)} style={{marginTop: '3px', transform: 'scale(1.2)'}} />
                            <span>
                                {isBookingFull ? (
                                    <>
                                        <strong>Estou ciente</strong> de que o agendamento só será confirmado em definitivo após o pagamento do valor total na próxima tela via InfinitePay. <br/><br/>
                                        <i className="fas fa-exclamation-triangle"></i> Sem o pagamento em até 15 minutos, o horário será cancelado e o espaço liberado para outra cliente.
                                    </>
                                ) : (
                                    <>
                                        <strong>Estou ciente</strong> de que o agendamento só será confirmado em definitivo após o pagamento do sinal na próxima tela via InfinitePay. <br/><br/>
                                        <i className="fas fa-exclamation-triangle"></i> Sem o pagamento em até 15 minutos, o horário será cancelado e o espaço liberado para outra cliente.
                                    </>
                                )}
                            </span>
                        </label>
                    </div>

                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
                        <button className="btn-submit" onClick={handleConfirmBooking} disabled={isLoading || !checkedTerms} style={{width: '100%', maxWidth: '400px', padding: '16px', fontSize: '18px', opacity: !checkedTerms ? 0.5 : 1}}>
                            {isLoading ? <><i className="fas fa-spinner fa-spin"></i> Gerando link InfinitePay…</> : 'Solicitar horário e ir ao pagamento'}
                        </button>
                        {apiError && <div className="alert alert-error" style={{marginTop: '20px'}}>{apiError}</div>}
                    </div>
                </div>
            )}

            {step === 4 && completedAppInfo && (
                <div className="booking-section step-container" style={{textAlign: 'center'}}>
                    <i className="fas fa-shield-halved" style={{fontSize: '46px', color: '#f59e0b', marginBottom: '12px' }}></i>
                    <h2 style={{ color: '#c2410c', marginBottom: '8px' }}>Quase lá — falta confirmar o pagamento</h2>
                    <p style={{ color: 'var(--text-muted)', marginBottom: '18px', maxWidth: '520px', marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.55 }}>
                        Seu horário foi reservado como <strong>pendente</strong> até o pagamento ser identificado. Para não perder o espaço, finalize agora — em geral o sistema libera o horário após <strong>15 minutos</strong> sem pagamento.
                    </p>

                    <div style={{ background: '#fcfcfc', border: '1px solid var(--border-color)', padding: '18px', borderRadius: '12px', textAlign: 'left', marginBottom: '16px', display: 'inline-block', maxWidth: '520px', width: '100%', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
                        <div style={{ fontSize: '12px', fontWeight: 800, color: '#64748b', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '10px' }}>Resumo do agendamento</div>

                        <div style={{ display: 'grid', gap: '10px' }}>
                            <div style={{ fontSize: '15px' }}>
                                <strong style={{ color: 'var(--primary-color)' }}>Cliente:</strong> {completedAppInfo.client.name}
                            </div>
                            <div style={{ fontSize: '15px' }}>
                                <strong style={{ color: 'var(--primary-color)' }}>Serviço:</strong> {completedAppInfo.service.name}{' '}
                                <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>({formatPrice(completedAppInfo.service.price)})</span>
                            </div>
                            <div style={{ fontSize: '15px' }}>
                                <strong style={{ color: 'var(--primary-color)' }}>Data e hora:</strong>{' '}
                                {new Date(completedAppInfo.app.date + 'T12:00:00').toLocaleDateString('pt-BR')} às <strong>{completedAppInfo.app.time}</strong>
                            </div>
                            <div style={{ fontSize: '15px' }}>
                                <strong style={{ color: 'var(--primary-color)' }}>Local:</strong> {completedAppInfo.app.location || 'Consultório Principal'}
                            </div>
                        </div>

                        <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid #e5e7eb' }}>
                            <div style={{ fontSize: '12px', fontWeight: 800, color: '#64748b', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '10px' }}>Pagamento</div>
                            <div style={{ display: 'grid', gap: '8px', fontSize: '14px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                                    <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>Forma escolhida</span>
                                    <strong style={{ color: '#0f172a' }}>{createdPaymentTypeLabel}</strong>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                                    <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>Valor cobrado agora</span>
                                    <strong style={{ color: '#0f172a' }}>{formatCurrencyBRL(createdDueNow)}</strong>
                                </div>
                                {createdIsPartial && createdRemaining > 0 && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                                        <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>Saldo restante</span>
                                        <strong style={{ color: '#0f172a' }}>{formatCurrencyBRL(createdRemaining)}</strong>
                                    </div>
                                )}
                                <div style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.45 }}>
                                    {createdIsPartial
                                        ? <>O valor do sinal é <strong>{signalDisplayBRL}</strong> (fixo). O valor acima em “Valor cobrado agora” é o que será cobrado no InfinitePay.</>
                                        : <>Você escolheu pagamento integral; o valor acima corresponde ao procedimento completo.</>}
                                </div>
                            </div>
                        </div>
                    </div>

                    {createdHasPayLink ? (
                        <div style={{ margin: '0 auto 18px', background: 'linear-gradient(180deg, #e0f2fe 0%, #f0f9ff 100%)', padding: '18px', borderRadius: '12px', maxWidth: '520px', width: '100%', border: '1px solid #bae6fd' }}>
                            <div style={{ fontSize: '12px', fontWeight: 900, color: '#075985', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '10px' }}>Próximo passo</div>
                            <div style={{ fontSize: '22px', fontWeight: 950, color: '#0c4a6e', marginBottom: '12px' }}>
                                {formatCurrencyBRL(createdDueNow)}
                            </div>
                            <a
                                href={createdPayUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn-submit pay-btn"
                                style={{ width: '100%', display: 'block', textDecoration: 'none', padding: '14px 16px', fontSize: '16px', fontWeight: 900 }}
                            >
                                <i className="fas fa-lock" style={{ marginRight: '10px' }}></i>
                                Pagar agora (abre em nova aba)
                            </a>
                            <div style={{ marginTop: '10px', fontSize: '12px', color: '#075985', lineHeight: 1.45 }}>
                                Depois de pagar, volte para <strong>Meus Agendamentos</strong> — o status atualiza automaticamente em alguns segundos.
                            </div>
                        </div>
                    ) : (
                        <div style={{ margin: '0 auto 18px', maxWidth: '520px', width: '100%', background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', padding: '14px', borderRadius: '12px', fontSize: '13px', lineHeight: 1.5 }}>
                            Não encontramos um link de pagamento válido ainda. Toque em atualizar no topo (ou volte e tente novamente). Se persistir, fale com a profissional pelo WhatsApp.
                        </div>
                    )}

                    <div style={{display: 'flex', flexDirection: 'column', gap: '15px', alignItems: 'center'}}>
                        <button className="btn-admin" style={{margin: '0 auto'}} onClick={() => { setStep(1); setBookingData({date:'', time:'', notes:'', location:''}); }}>Fazer novo/voltar início</button>
                    </div>
                </div>
            )}
        </div>
    );
};


// ============== ROOT APP (ORQUESTRADOR DB) ==============

const App = () => {
    const [view, setView] = useState('client'); 
    const [showPassword, setShowPassword] = useState(false);

    const readStoredAdminToken = () => {
        try {
            return sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '';
        } catch {
            return '';
        }
    };

    const [adminToken, setAdminToken] = useState(readStoredAdminToken);
    
    const [appointments, setAppointments] = useState([]);
    const [clients, setClients] = useState([]);
    const [blockedSlots, setBlockedSlots] = useState([]);
    const [config, setConfig] = useState({ profPhone: '' });
    const [dbStatus, setDbStatus] = useState('conectando...');

    const handleAdminLoginSuccess = (token) => {
        try {
            sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
        } catch (_) { /* ignore */ }
        setAdminToken(token);
        setShowPassword(false);
        setView('admin');
    };

    const handleAdminSessionInvalid = useCallback(() => {
        try {
            sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
        } catch (_) { /* ignore */ }
        setAdminToken('');
        setShowPassword(true);
    }, []);

    // Função de Refresh Principal
    const refreshData = useCallback(async () => {
        const blkHeaders = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
        try {
            const resAps = await fetch(`${API_BASE_URL}/appointments`);
            if (resAps.ok) {
                const aps = await resAps.json();
                setAppointments(aps);
                setDbStatus('PostgreSQL Conectado');
            } else { setDbStatus('Erro Conexão API'); }

            const resClis = await fetch(`${API_BASE_URL}/clients`);
            if (resClis.ok) setClients(await resClis.json());

            const resBlk = await fetch(`${API_BASE_URL}/admin/blocked-slots`, { headers: blkHeaders });
            if (resBlk.status === 401) {
                try {
                    sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
                } catch (_) { /* ignore */ }
                setAdminToken('');
                setBlockedSlots([]);
            } else if (resBlk.ok) {
                setBlockedSlots(await resBlk.json());
            } else {
                setBlockedSlots([]);
            }
        } catch(e) { 
            console.error(e); setDbStatus('Offline'); 
        }
    }, [adminToken]);

    useEffect(() => {
        refreshData();
        const savedConfig = localStorage.getItem('atelie_config');
        if (savedConfig) setConfig(JSON.parse(savedConfig));

        // POLLING AUTOMÁTICO A CADA 10 SEGUNDOS
        const intervalId = setInterval(refreshData, 10000);
        return () => clearInterval(intervalId);
    }, [refreshData]);

    const navigateTo = (tView) => {
        if (tView === 'admin' && view !== 'admin') {
            const t = readStoredAdminToken();
            if (t) {
                setAdminToken(t);
                setView('admin');
            } else {
                setShowPassword(true);
            }
        } else {
            setView(tView);
        }
    };

    return (
        <div className="container">
            <Header view={view} setView={navigateTo} />
            {showPassword && <PasswordModal onSuccess={handleAdminLoginSuccess} onCancel={() => setShowPassword(false)} />}
            
            <div style={{textAlign: 'center', fontSize: '11px', padding: '4px', background: dbStatus.includes('Conectado') ? '#d4edda' : '#f8d7da', color: dbStatus.includes('Conectado') ? '#155724' : '#721c24', marginBottom: '20px', borderRadius: '4px'}}>
               Status do Driver DB: {dbStatus} (Polling 10s)
            </div>

            <main>
                {view === 'client' && <ClientArea appointments={appointments} refreshData={refreshData} clients={clients} config={config} blockedSlots={blockedSlots} />}
                {view === 'my_apps' && <MyAppointmentsArea appointments={appointments} refreshData={refreshData} clients={clients} setView={setView} />}
                {view === 'admin' && (
                    <AdminArea
                        appointments={appointments}
                        refreshData={refreshData}
                        clients={clients}
                        config={config}
                        setConfig={setConfig}
                        blockedSlots={blockedSlots}
                        adminToken={adminToken}
                        onAdminSessionInvalid={handleAdminSessionInvalid}
                    />
                )}
            </main>
        </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
    