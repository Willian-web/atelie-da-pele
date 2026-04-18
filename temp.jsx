
const { useState, useEffect, useMemo, useCallback } = React;

const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:8080' : 'https://' + window.location.hostname;

const SERVICES = [
    { id: 'limpeza_pele', name: 'Limpeza de Pele', price: 119.90, category: 'Estética Facial', duration: 60 },
    { id: 'dep_intima', name: 'Depilação Íntima Completa', price: 59.90, category: 'Depilação', duration: 60 },
    { id: 'dep_axila', name: 'Depilação Axila', price: 29.90, category: 'Depilação', duration: 60 },
    { id: 'dep_buco', name: 'Depilação Buço', price: 29.90, category: 'Depilação', duration: 60 },
    { id: 'dep_completa', name: 'Depilação Completa', price: 129.90, category: 'Depilação', duration: 60 },
    { id: 'reflexologia', name: 'Reflexologia Podal', price: 89.90, category: 'Bem-Estar', duration: 60 }
];

const formatPrice = (price) => price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const getLocalTodayStr = () => {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().split('T')[0];
};

const generateTimeSlots = (dateString, existingAppointments) => {
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
    
    // Status que ocupam a agenda: pending_payment, confirmed, completed
    const bookedIntervals = existingAppointments
        .filter(app => app.date === dateString && ['pending_payment', 'confirmed', 'completed'].includes(app.status))
        .map(app => {
            const [h, m] = app.time.split(':');
            const startMins = parseInt(h) * 60 + parseInt(m);
            const service = SERVICES.find(s => s.id === app.serviceId);
            const duration = service ? service.duration : 60;
            return { start: startMins, end: startMins + duration };
        });
        
    return slots.map(time => {
        const [hStr, mStr] = time.split(':');
        const slotStartMins = parseInt(hStr) * 60 + parseInt(mStr);
        const slotEndMins = slotStartMins + 30; 
        const isPast = isToday && slotStartMins <= currentTotalMinutes;
        const isBooked = bookedIntervals.some(booked => slotStartMins < booked.end && slotEndMins > booked.start);
        
        return { time, available: !isBooked && !isPast, isPast: isPast, isBooked: isBooked };
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
    const [error, setError] = useState(false);
    const checkPassword = () => { pwd === '1234' ? onSuccess() : (setError(true), setPwd('')); };
    return (
        <div className="password-overlay">
            <div className="password-modal">
                <i className="fas fa-shield-alt" style={{fontSize: '40px', color: 'var(--primary-color)', marginBottom: '15px'}}></i>
                <h3 style={{marginBottom: '20px'}}>Administração</h3>
                {error && <div className="alert alert-error" style={{padding: '8px', marginBottom: '15px', fontSize: '13px'}}>Senha Incorreta.</div>}
                <input type="password" className="form-control password-input" placeholder="****" value={pwd} onChange={e => setPwd(e.target.value)} onKeyDown={e => e.key === 'Enter' && checkPassword()} autoFocus />
                <div className="modal-actions"><button className="btn-cancel" onClick={onCancel}>Voltar</button><button className="btn-submit" style={{flex: 1}} onClick={checkPassword}>Acessar</button></div>
            </div>
        </div>
    );
};

const StatusBadge = ({ status }) => {
    switch (status) {
        case 'pending_payment': return <span className="status-badge st-pending"><i className="fas fa-clock"></i> Aguardando Pagamento</span>;
        case 'confirmed': return <span className="status-badge st-confirmed"><i className="fas fa-check"></i> Confirmado</span>;
        case 'cancelled': return <span className="status-badge st-cancelled"><i className="fas fa-times"></i> Cancelado</span>;
        case 'completed': return <span className="status-badge st-completed"><i className="fas fa-flag-checkered"></i> Concluído</span>;
        default: return null;
    }
}

// ============== ÁREA PROFISSIONAL ==============

const AdminArea = ({ appointments, refreshData, clients, config, setConfig }) => {
    const [adminView, setAdminView] = useState('agenda');
    const [filter, setFilter] = useState('all');
    const [profPhoneInput, setProfPhoneInput] = useState(config.profPhone || '');
    
    const todayStr = getLocalTodayStr();

    const handleDelete = async (id) => {
        if(window.confirm('Apagar DEIFINITIVAMENTE? Irreversível.')) {
            try {
                await fetch(`${API_BASE_URL}/appointments/${id}`, { method: 'DELETE' });
                refreshData();
            } catch(e) { console.error(e) }
        }
    };

    const handleCancelByAdmin = async (id) => {
        const reason = window.prompt('Motivo do cancelamento (opcional)?');
        if(reason !== null) {
            try {
                await fetch(`${API_BASE_URL}/appointments/${id}/cancel`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cancelledBy: 'admin', cancelReason: reason })
                });
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

    let filteredApps = appointments;
    if (filter === 'today') filteredApps = appointments.filter(a => a.date === todayStr);
    else if (filter === 'next') filteredApps = appointments.filter(a => a.date > todayStr);
    
    const sortedApps = [...filteredApps].sort((a, b) => new Date(a.date + 'T' + a.time) - new Date(b.date + 'T' + b.time));

    return (
        <div className="booking-section step-container">
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <h2 className="section-title" style={{margin:0}}>Painel Profissional</h2>
                <button className="refresh-btn" onClick={refreshData} title="Atualizar agora"><i className="fas fa-sync-alt"></i></button>
            </div>
            
            <div className="filter-tabs" style={{marginTop: '20px', borderBottom: '1px solid #eee', paddingBottom: '15px'}}>
                <button className={`tab-btn ${adminView === 'agenda' ? 'active' : ''}`} onClick={() => setAdminView('agenda')}><i className="fas fa-calendar-alt"></i> Agenda Geral</button>
                <button className={`tab-btn ${adminView === 'clientes' ? 'active' : ''}`} onClick={() => setAdminView('clientes')}><i className="fas fa-users"></i> Radar de Clientes</button>
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
                    
                    <div className="appointments-list">
                        {sortedApps.length === 0 ? <div className="empty-state"><i className="fas fa-box-open"></i><p>Nada agendado neste filtro.</p></div> : 
                            sortedApps.map(app => {
                                const service = SERVICES.find(s => s.id === app.serviceId) || {name: 'Serviço Removido'};
                                const dateStr = new Date(app.date + 'T12:00:00').toLocaleDateString('pt-BR');
                                const isCancelled = app.status === 'cancelled';
                                return (
                                    <div key={app.id} className="appointment-item" style={isCancelled ? {opacity: 0.6, borderLeft: '4px solid #ef4444'} : {borderLeft: '4px solid var(--primary-color)'}}>
                                        <div className="appointment-info" style={{flex: 1}}>
                                            <div className="appointment-cliente" style={{display:'flex', alignItems: 'center'}}>
                                                {app.clientName} <StatusBadge status={app.status} />
                                            </div>
                                            <div className="appointment-details">
                                                <div className="detail-badge"><i className="far fa-clock"></i> {dateStr} às {app.time}</div>
                                                <div className="detail-badge"><i className="fas fa-spa"></i> {service.name}</div>
                                                <div className="detail-badge"><i className="fas fa-phone"></i> {app.clientPhone}</div>
                                            </div>
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
                            <div key={client.id} className="appointment-item" style={{alignItems: 'center'}}>
                                <div className="appointment-info" style={{flex: 1}}>
                                    <div className="appointment-cliente" style={{color: 'var(--primary-color)', fontSize: '1.2rem', marginBottom: '8px'}}><i className="fas fa-user-circle" style={{marginRight: '8px'}}></i> {client.name}</div>
                                    <div className="appointment-details">
                                        <div className="detail-badge"><i className="fab fa-whatsapp"></i> {client.phone}</div>
                                        {client.address && <div className="detail-badge"><i className="fas fa-map-marker-alt"></i> {client.address}</div>}
                                    </div>
                                </div>
                                <div className="appointment-actions">
                                    <a href={`https://wa.me/55${client.phone}`} target="_blank" className="btn-cancel" style={{color: '#25D366', borderColor: '#25D366', padding: '8px 16px', display: 'inline-flex', alignItems: 'center', gap: '8px', textDecoration: 'none'}}>
                                        <i className="fab fa-whatsapp" style={{fontSize: '18px'}}></i> Conversar
                                    </a>
                                </div>
                            </div>
                        ))
                    }
                </div>
            )}
        </div>
    );
};


// ============== ÁREA "MEUS AGENDAMENTOS" (CLIENTE LOGADO) ==============

const MyAppointmentsArea = ({ appointments, refreshData, clients, setView }) => {
    const [loginPhone, setLoginPhone] = useState('');
    const [loggedInUser, setLoggedInUser] = useState(null);
    const [loginError, setLoginError] = useState('');

    const handleLogin = () => {
        const cleanLogin = loginPhone.replace(/\D/g, '');
        const c = clients.find(cl => cl.phone.replace(/\D/g, '') === cleanLogin);
        if(c) {
            setLoggedInUser(c); setLoginError('');
        } else {
            setLoginError('Cliente não encontrada no sistema.');
        }
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

    if (!loggedInUser) {
        return (
            <div className="booking-section step-container">
                <button className="btn-admin" onClick={() => setView('client')} style={{marginBottom: '20px'}}><i className="fas fa-arrow-left"></i> Voltar</button>
                <h2 className="section-title">Visualizar Meus Agendamentos</h2>
                <div className="form-group">
                    <label className="form-label">Digite seu número (WhatsApp) cadastrado:</label>
                    <input type="text" className="form-control" value={loginPhone} onChange={e => setLoginPhone(e.target.value)} placeholder="Ex: 11999999999" />
                    {loginError && <div style={{color: 'var(--danger)', fontSize: '13px', marginTop: '8px'}}>{loginError}</div>}
                    <button className="btn-submit" style={{marginTop: '15px'}} onClick={handleLogin}>Entrar</button>
                </div>
            </div>
        );
    }

    const myApps = appointments.filter(a => a.clientId === loggedInUser.id).sort((a,b) => new Date(b.date + 'T' + b.time) - new Date(a.date + 'T' + a.time));

    return (
        <div className="booking-section step-container">
            <div style={{display: 'flex', justifyContent: 'space-between'}}>
                <button className="btn-admin" onClick={() => setView('client')} style={{marginBottom: '20px'}}><i className="fas fa-arrow-left"></i> Voltar Início</button>
                <button className="refresh-btn" onClick={refreshData} title="Atualizar agora"><i className="fas fa-sync-alt"></i></button>
            </div>
            <h2 className="section-title">Olá, {loggedInUser.name.split(' ')[0]}!</h2>
            <div className="appointments-list" style={{marginTop: '20px'}}>
                {myApps.length === 0 ? <div className="empty-state"><i className="fas fa-calendar-times"></i><p>Nenhum histórico.</p></div> : 
                    myApps.map(app => {
                        const service = SERVICES.find(s => s.id === app.serviceId) || {name: 'Serviço'};
                        const dateStr = new Date(app.date + 'T12:00:00').toLocaleDateString('pt-BR');
                        const isPast = new Date(app.date + 'T' + app.time) < new Date();
                        const isCancelled = app.status === 'cancelled';
                        const isPending = app.status === 'pending_payment';

                        // Verifica se pode cancelar
                        const apTime = new Date(app.date + 'T' + app.time + ':00-03:00').getTime();
                        const canCancel = (apTime - new Date().getTime()) >= (2 * 60 * 60 * 1000); // Faltam 2+ horas
                        
                        return (
                            <div key={app.id} className="appointment-item" style={isCancelled ? {opacity: 0.6, borderLeft: '4px solid #ef4444'} : (isPast ? {opacity: 0.8} : {borderLeft: '4px solid var(--primary-color)'})}>
                                <div className="appointment-info" style={{flex: 1}}>
                                    <div className="appointment-details" style={{marginBottom: '10px'}}>
                                        <div className="detail-badge"><i className="far fa-clock"></i> {dateStr} às {app.time}</div>
                                        <div className="detail-badge"><i className="fas fa-spa"></i> {service.name}</div>
                                        <StatusBadge status={app.status} />
                                    </div>
                                    {app.location && <div className="obs-text"><strong>Endereço do Local:</strong> {app.location}</div>}
                                </div>
                                <div className="appointment-actions" style={{display:'flex', flexDirection:'column', gap:'5px', minWidth: '130px'}}>
                                    {isPending && !isCancelled && !isPast && (
                                        <>
                                            <a href={app.paymentUrl || '#'} target="_blank" className="btn-submit pay-btn" style={{padding: '6px', fontSize: '13px', textAlign:'center', textDecoration: 'none'}}>Pagar Adiantamento</a>
                                            <button className="btn-cancel" onClick={() => simulaPagamento(app.id)} style={{fontSize: '11px', padding: '4px'}}>Simular MOCK</button>
                                        </>
                                    )}
                                    {!isPast && !isCancelled && canCancel && (
                                        <button className="btn-cancel" onClick={() => handleCancelAppointment(app)} title="Cancelar Agendamento" style={{color: '#ef4444', borderColor: '#ef4444', padding: '6px'}}>Cancelar (<2h)</button>
                                    )}
                                    {!canCancel && !isPast && !isCancelled && (
                                        <span style={{fontSize: '11px', color:'#777', textAlign:'center'}}>Cancelamento bloqueado (faltam -2h)</span>
                                    )}
                                </div>
                            </div>
                        );
                    })
                }
            </div>
        </div>
    );
};

// ============== ÁREA NOVO AGENDAMENTO (FLOW PRINCIPAL) ==============

const ClientArea = ({ appointments, refreshData, clients, config }) => {
    const [step, setStep] = useState(1);
    
    // Step 1
    const [selectedService, setSelectedService] = useState('');
    const [bookingData, setBookingData] = useState({ date: '', time: '', notes: '', location: '' });
    const [availableTimes, setAvailableTimes] = useState([]);
    
    // Step 2
    const [loginPhone, setLoginPhone] = useState('');
    const [loginError, setLoginError] = useState('');
    const [selectedClient, setSelectedClient] = useState(null);
    const [newClient, setNewClient] = useState({ name: '', phone: '', address: '' });
    const [isCreatingNew, setIsCreatingNew] = useState(false);

    // Step 3
    const [checkedTerms, setCheckedTerms] = useState(false);

    // Step 4
    const [completedAppInfo, setCompletedAppInfo] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [apiError, setApiError] = useState('');

    const todayStr = getLocalTodayStr();

    useEffect(() => {
        if (bookingData.date) {
            setAvailableTimes(generateTimeSlots(bookingData.date, appointments));
            setBookingData(prev => ({...prev, time: ''}));
        } else {
            setAvailableTimes([]);
        }
    }, [bookingData.date, appointments]);

    const handleCreateClient = async () => {
        if(!newClient.name || !newClient.phone) return alert('Nome e Telefone são obrigatórios.');
        const cleanPhone = newClient.phone.replace(/\D/g, '');
        
        setIsLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/clients`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: Date.now().toString(), name: newClient.name, phone: cleanPhone, address: newClient.address })
            });
            const data = await res.json();
            setSelectedClient(data);
            setIsCreatingNew(false);
            setStep(3); // Avança pra confirmação dedicada
            refreshData(); // Puxa clients atualizados
        } catch (e) {
            alert('Falha ao registrar cliente no banco de dados.');
        }
        setIsLoading(false);
    };

    const handleConfirmBooking = async () => {
        if(!checkedTerms) return alert("Você precisa aceitar os termos de pagamento do adiantamento.");

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
                    date: bookingData.date,
                    time: bookingData.time,
                    notes: bookingData.notes,
                    location: bookingData.location,
                    price: serviceObj.price
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
    const adiantamento = priceObj ? (priceObj.price * 0.3).toFixed(2) : 0;

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
                            <div className="form-group"><label className="form-label">Endereço Residencial</label><input type="text" className="form-control" value={newClient.address} onChange={e=>setNewClient({...newClient, address: e.target.value})}/></div>
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
                        <div style={{fontSize: '16px', borderTop: '1px solid #ddd', paddingTop: '10px', marginTop: '15px'}}><strong style={{color: '#00A676'}}>Valor Serviço:</strong> {formatPrice(priceObj.price)}</div>
                        <div style={{fontSize: '16px', color: '#eab308', fontWeight: 'bold'}}><strong style={{color: '#eab308'}}>PagBank Adiantamento (30%):</strong> R$ {adiantamento}</div>
                    </div>

                    {/* TERMO PAGBANK OBRIGATÓRIO (REQUISITO 4) */}
                    <div style={{background: '#fff3cd', border: '1px solid #ffeeba', padding: '15px', borderRadius: '8px', maxWidth: '400px', margin: '0 auto 20px', textAlign: 'left'}}>
                        <label style={{display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer', fontSize: '14px', color: '#856404'}}>
                            <input type="checkbox" checked={checkedTerms} onChange={e => setCheckedTerms(e.target.checked)} style={{marginTop: '3px', transform: 'scale(1.2)'}} />
                            <span>
                                <strong>Estou ciente</strong> de que o agendamento só será confirmado em definitivo após o pagamento do adiantamento na próxima tela via PagBank. <br/><br/>
                                <i className="fas fa-exclamation-triangle"></i> Sem o pagamento em até 15 minutos, o horário será cancelado e o espaço liberado para outra que deseja o serviço.
                            </span>
                        </label>
                    </div>

                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
                        <button className="btn-submit" onClick={handleConfirmBooking} disabled={isLoading || !checkedTerms} style={{width: '100%', maxWidth: '400px', padding: '16px', fontSize: '18px', opacity: !checkedTerms ? 0.5 : 1}}>
                            {isLoading ? <><i className="fas fa-spinner fa-spin"></i> Emitindo PagBank...</> : 'Solicitar Horário & Ir ao Pagamento'}
                        </button>
                        {apiError && <div className="alert alert-error" style={{marginTop: '20px'}}>{apiError}</div>}
                    </div>
                </div>
            )}

            {step === 4 && completedAppInfo && (
                <div className="booking-section step-container" style={{textAlign: 'center'}}>
                    <i className="fas fa-clock" style={{fontSize: '50px', color: '#f59e0b', marginBottom: '15px'}}></i>
                    <h2 style={{color: '#d97706', marginBottom: '10px'}}>Horário Bloqueado Aguardando Pagamento</h2>
                    <p style={{color: 'var(--text-muted)', marginBottom: '20px'}}>Pague o adiantamento de 30% dentro dos próximos 15 minutos para que não seja cancelado.</p>
                    
                    <div style={{background: '#fcfcfc', border: '1px solid #ddd', padding: '20px', borderRadius: '8px', textAlign: 'left', marginBottom: '25px', display: 'inline-block', maxWidth: '400px', width: '100%'}}>
                        <strong>{completedAppInfo.client.name}</strong><br/>
                        {completedAppInfo.service.name}<br/>
                        Para: {new Date(completedAppInfo.app.date + 'T12:00:00').toLocaleDateString('pt-BR')} às {completedAppInfo.app.time} <br/>
                        Local: {completedAppInfo.app.location || 'Consultório Principal'}
                    </div>

                    <div style={{marginBottom: '30px', background: '#e0f2fe', padding: '20px', borderRadius: '8px', maxWidth: '350px', margin: '0 auto 30px'}}>
                        <p style={{fontWeight: 'bold', fontSize: '18px', color: '#0369a1', marginBottom: '15px'}}>Valor a pagar agora: R$ {adiantamento}</p>
                        <a href={completedAppInfo.app.paymentUrl} target="_blank" className="btn-submit pay-btn" style={{width: '100%', display: 'block', textDecoration: 'none', padding: '15px'}}>
                            <i className="fas fa-money-bill-wave"></i> Realizar Pagamento via PagBank
                        </a>
                    </div>

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
    
    const [appointments, setAppointments] = useState([]);
    const [clients, setClients] = useState([]);
    const [config, setConfig] = useState({ profPhone: '' });
    const [dbStatus, setDbStatus] = useState('conectando...');

    // Função de Refresh Principal
    const refreshData = useCallback(async () => {
        try {
            const resAps = await fetch(`${API_BASE_URL}/appointments`);
            if (resAps.ok) {
                const aps = await resAps.json();
                setAppointments(aps);
                setDbStatus('PostgreSQL Conectado');
            } else { setDbStatus('Erro Conexão API'); }

            const resClis = await fetch(`${API_BASE_URL}/clients`);
            if (resClis.ok) setClients(await resClis.json());
        } catch(e) { 
            console.error(e); setDbStatus('Offline'); 
        }
    }, []);

    useEffect(() => {
        refreshData();
        const savedConfig = localStorage.getItem('atelie_config');
        if (savedConfig) setConfig(JSON.parse(savedConfig));

        // POLLING AUTOMÁTICO A CADA 10 SEGUNDOS
        const intervalId = setInterval(refreshData, 10000);
        return () => clearInterval(intervalId);
    }, [refreshData]);

    const navigateTo = (tView) => {
        if(tView === 'admin' && view !== 'admin') setShowPassword(true);
        else setView(tView);
    };

    return (
        <div className="container">
            <Header view={view} setView={navigateTo} />
            {showPassword && <PasswordModal onSuccess={() => { setShowPassword(false); setView('admin'); }} onCancel={() => setShowPassword(false)} />}
            
            <div style={{textAlign: 'center', fontSize: '11px', padding: '4px', background: dbStatus.includes('Conectado') ? '#d4edda' : '#f8d7da', color: dbStatus.includes('Conectado') ? '#155724' : '#721c24', marginBottom: '20px', borderRadius: '4px'}}>
               Status do Driver DB: {dbStatus} (Polling 10s)
            </div>

            <main>
                {view === 'client' && <ClientArea appointments={appointments} refreshData={refreshData} clients={clients} config={config} />}
                {view === 'my_apps' && <MyAppointmentsArea appointments={appointments} refreshData={refreshData} clients={clients} setView={setView} />}
                {view === 'admin' && <AdminArea appointments={appointments} refreshData={refreshData} clients={clients} config={config} setConfig={setConfig} />}
            </main>
        </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
    