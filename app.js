const { useState, useEffect } = React;

const SERVICES = [
    { id: 'limpeza_pele', name: 'Limpeza de Pele', price: 119.90, category: 'Estética Facial' },
    { id: 'dep_intima', name: 'Depilação Íntima Completa', price: 59.90, category: 'Depilação' },
    { id: 'dep_axila', name: 'Depilação Axila', price: 29.90, category: 'Depilação' },
    { id: 'dep_buco', name: 'Depilação Buço', price: 29.90, category: 'Depilação' },
    { id: 'dep_completa', name: 'Depilação Completa', price: 129.90, category: 'Depilação' },
    { id: 'reflexologia', name: 'Reflexologia Podal', price: 89.90, category: 'Bem-Estar' }
];

// Helper to format currency
const formatPrice = (price) => {
    return price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

// Generates timeslots based on day of week
const generateTimeSlots = (dateString, existingAppointments) => {
    if (!dateString) return [];
    
    // Create date appending time to avoid timezone shift on local dates
    const date = new Date(dateString + 'T12:00:00');
    const dayOfWeek = date.getDay(); // 0 is Sunday, 1 is Monday...
    
    let slots = [];
    
    if (dayOfWeek === 0) {
        // Sunday closed
        return [];
    } else if (dayOfWeek === 6) {
        // Sat 14:00 - 17:30 (last slot at 17:00)
        let hour = 14;
        let min = 0;
        while (hour < 17 || (hour === 17 && min === 0)) {
            slots.push(`${hour.toString().padStart(2, '0')}:${min === 0 ? '00' : '30'}`);
            min += 30;
            if (min >= 60) {
                hour += 1;
                min = 0;
            }
        }
    } else {
        // Mon-Fri 13:00 - 20:00 (last slot at 19:30)
        let hour = 13;
        let min = 0;
        while (hour < 19 || (hour === 19 && min <= 30)) {
            slots.push(`${hour.toString().padStart(2, '0')}:${min === 0 ? '00' : '30'}`);
            min += 30;
            if (min >= 60) {
                hour += 1;
                min = 0;
            }
        }
    }
    
    // Filter out already booked slots for this date
    const bookedSlots = existingAppointments
        .filter(app => app.date === dateString)
        .map(app => app.time);
        
    return slots.map(time => ({
        time,
        available: !bookedSlots.includes(time)
    }));
};

const Header = ({ setView, view }) => (
    <div className="top-bar">
        <div className="logo" onClick={() => setView('client')} style={{cursor: 'pointer'}}>
            <span className="logo-main">Ateliê da Pele</span>
            <span className="logo-sub">Estética & Bem Estar</span>
        </div>
        <button 
            className={`btn-admin ${view === 'admin' ? 'active' : ''}`}
            onClick={() => setView('admin')}
        >
            <i className="fas fa-lock"></i>
            Área do Profissional
        </button>
    </div>
);

const PasswordModal = ({ onSuccess, onCancel }) => {
    const [pwd, setPwd] = useState('');
    const [error, setError] = useState(false);

    const checkPassword = () => {
        if (pwd === '1234') {
            onSuccess();
        } else {
            setError(true);
            setPwd('');
        }
    };

    return (
        <div className="password-overlay">
            <div className="password-modal">
                <i className="fas fa-shield-alt" style={{fontSize: '40px', color: 'var(--primary-color)', marginBottom: '15px'}}></i>
                <h3 style={{marginBottom: '20px'}}>Área Restrita</h3>
                {error && <div className="alert alert-error" style={{padding: '8px', marginBottom: '15px', fontSize: '13px'}}>Senha Incorreta. Tente "1234".</div>}
                
                <input 
                    type="password" 
                    className="form-control password-input" 
                    placeholder="****"
                    value={pwd}
                    onChange={e => setPwd(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && checkPassword()}
                    autoFocus
                />
                
                <div className="modal-actions">
                    <button className="btn-cancel" onClick={onCancel}>Cancelar</button>
                    <button className="btn-submit" style={{flex: 1, padding: '10px'}} onClick={checkPassword}>Acessar</button>
                </div>
            </div>
        </div>
    );
};

const AdminArea = ({ appointments, setAppointments }) => {
    const handleDelete = (id) => {
        if(window.confirm('Tem certeza que deseja excluir esse agendamento? O horário voltará a ficar disponível para novos clientes.')) {
            const updated = appointments.filter(a => a.id !== id);
            setAppointments(updated);
            localStorage.setItem('atelie_appointments', JSON.stringify(updated));
        }
    };

    // Sort by date and time
    const sortedApps = [...appointments].sort((a, b) => {
        const dateA = new Date(a.date + 'T' + a.time);
        const dateB = new Date(b.date + 'T' + b.time);
        return dateA - dateB;
    });

    return (
        <div className="booking-section" style={{animation: 'fadeIn 0.4s ease'}}>
            <div className="admin-header">
                <h2>Gerenciador de Agenda</h2>
                <div className="detail-badge">
                    <i className="fas fa-calendar-check"></i>
                    {appointments.length} Consultas
                </div>
            </div>
            
            <div className="appointments-list">
                {sortedApps.length === 0 ? (
                    <div className="empty-state">
                        <i className="fas fa-box-open"></i>
                        <p>Nenhum agendamento realizado ainda.</p>
                    </div>
                ) : (
                    sortedApps.map(app => {
                        const service = SERVICES.find(s => s.id === app.serviceId) || {name: 'Serviço Removido', price: 0};
                        
                        // Format date to BR format
                        const dateObj = new Date(app.date + 'T12:00:00');
                        const dateStr = dateObj.toLocaleDateString('pt-BR');
                        
                        return (
                            <div key={app.id} className="appointment-item">
                                <div className="appointment-info">
                                    <div className="appointment-cliente">{app.name}</div>
                                    <div className="appointment-details">
                                        <div className="detail-badge"><i className="far fa-clock"></i> {dateStr} às {app.time}</div>
                                        <div className="detail-badge"><i className="fas fa-spa"></i> {service.name}</div>
                                        <div className="detail-badge"><i className="fas fa-phone"></i> {app.phone}</div>
                                        <div className="detail-badge" style={{backgroundColor: '#e0e7ff', color: '#3730a3'}}><i className="fas fa-tag"></i> {formatPrice(service.price)}</div>
                                    </div>
                                    {app.notes && (
                                        <div className="obs-text">
                                            <strong>Obs:</strong> {app.notes}
                                        </div>
                                    )}
                                </div>
                                <button className="btn-delete" onClick={() => handleDelete(app.id)} title="Excluir Horário">
                                    <i className="fas fa-trash-alt"></i>
                                </button>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

const ClientArea = ({ appointments, setAppointments }) => {
    const [selectedService, setSelectedService] = useState('');
    const [formData, setFormData] = useState({
        name: '', phone: '', date: '', time: '', notes: ''
    });
    const [availableTimes, setAvailableTimes] = useState([]);
    const [successMessage, setSuccessMessage] = useState('');

    // Today's date in YYYY-MM-DD for min attribute
    const todayStr = new Date().toISOString().split('T')[0];

    // Whenever date changes or appointments change, refresh available times
    useEffect(() => {
        if (formData.date) {
            setAvailableTimes(generateTimeSlots(formData.date, appointments));
            // Reset selected time if it's no longer available
            setFormData(prev => ({...prev, time: ''}));
        } else {
            setAvailableTimes([]);
        }
    }, [formData.date, appointments]);

    const handleServiceSelect = (id) => {
        setSelectedService(id);
        setSuccessMessage('');
    };

    const handleChange = (e) => {
        setFormData({
            ...formData,
            [e.target.name]: e.target.value
        });
        setSuccessMessage('');
    };

    const handleTimeSelect = (timeSlot) => {
        if (timeSlot.available) {
            setFormData({...formData, time: timeSlot.time});
        }
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        
        if (!selectedService || !formData.name || !formData.phone || !formData.date || !formData.time) {
            alert('Por favor, preencha todos os campos obrigatórios (Serviço, Nome, Telefone, Data e Horário).');
            return;
        }

        const newAppointment = {
            id: Date.now().toString(),
            serviceId: selectedService,
            ...formData,
            createdAt: new Date().toISOString()
        };

        const updatedAppointments = [...appointments, newAppointment];
        setAppointments(updatedAppointments);
        localStorage.setItem('atelie_appointments', JSON.stringify(updatedAppointments));
        
        setSuccessMessage('Agendamento realizado com sucesso! Esperamos por você.');
        
        // Reset form
        setSelectedService('');
        setFormData({ name: '', phone: '', date: '', time: '', notes: '' });
    };

    return (
        <div>
            {successMessage && (
                <div className="alert alert-success">
                    <i className="fas fa-check-circle"></i> {successMessage}
                </div>
            )}
            
            <div className="booking-section">
                <h2 className="section-title">O que você deseja cuidar hoje?</h2>
                <div className="services-grid">
                    {SERVICES.map(service => (
                        <div 
                            key={service.id} 
                            className={`service-card ${selectedService === service.id ? 'selected' : ''}`}
                            onClick={() => handleServiceSelect(service.id)}
                        >
                            <div className="service-card-header">
                                <h3>{service.name}</h3>
                                <i className="fas fa-check-circle service-check"></i>
                            </div>
                            <div style={{fontSize: '13px', color: 'var(--text-muted)'}}>{service.category}</div>
                            <div className="service-price">{formatPrice(service.price)}</div>
                        </div>
                    ))}
                </div>

                <h2 className="section-title" style={{marginTop: '40px'}}>Detalhes do Agendamento</h2>
                
                <form onSubmit={handleSubmit} className="form-grid">
                    <div className="form-group">
                        <label className="form-label">Nome Completo *</label>
                        <input type="text" name="name" className="form-control" placeholder="Seu nome" value={formData.name} onChange={handleChange} required />
                    </div>
                    
                    <div className="form-group">
                        <label className="form-label">WhatsApp *</label>
                        <input type="tel" name="phone" className="form-control" placeholder="(00) 00000-0000" value={formData.phone} onChange={handleChange} required />
                    </div>
                    
                    <div className="form-group">
                        <label className="form-label">Escolha a Data *</label>
                        <input type="date" name="date" className="form-control" min={todayStr} value={formData.date} onChange={handleChange} required />
                        
                        {formData.date && new Date(formData.date + 'T12:00:00').getDay() === 0 && (
                            <div className="day-closed-msg">
                                <i className="fas fa-door-closed"></i> Fechado aos domingos. Escolha outra data.
                            </div>
                        )}
                    </div>
                    
                    <div className="form-group">
                        <label className="form-label">Horários Disponíveis *</label>
                        {!formData.date ? (
                            <div style={{color: 'var(--text-muted)', fontSize: '14px', padding: '10px 0'}}>Selecione uma data para ver os horários.</div>
                        ) : availableTimes.length === 0 ? (
                            <div style={{color: 'var(--danger)', fontSize: '14px', padding: '10px 0'}}>Nenhum horário disponível para esta data.</div>
                        ) : (
                            <div className="time-slots">
                                {availableTimes.map((slot, idx) => (
                                    <div 
                                        key={idx}
                                        className={`time-slot ${!slot.available ? 'disabled' : ''} ${formData.time === slot.time ? 'selected' : ''}`}
                                        onClick={() => handleTimeSelect(slot)}
                                    >
                                        {slot.time}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="form-group full-width">
                        <label className="form-label">Observações (Opcional)</label>
                        <textarea name="notes" className="form-control" placeholder="Alguma informação importante que devemos saber?" value={formData.notes} onChange={handleChange}></textarea>
                    </div>

                    <div className="form-group full-width">
                        <button type="submit" className="btn-submit" disabled={!selectedService || !formData.date || !formData.time || !formData.name || !formData.phone}>
                            <i className="fas fa-calendar-check"></i> Agendar e Reservar Horário
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

const App = () => {
    const [view, setView] = useState('client'); // 'client', 'admin'
    const [showPassword, setShowPassword] = useState(false);
    const [appointments, setAppointments] = useState([]);

    // Load initial data
    useEffect(() => {
        const saved = localStorage.getItem('atelie_appointments');
        if (saved) {
            try {
                setAppointments(JSON.parse(saved));
            } catch (e) {
                console.error("Erro ao ler localStorage", e);
            }
        }
    }, []);

    const navigateTo = (targetView) => {
        if (targetView === 'admin' && view !== 'admin') {
            setShowPassword(true);
        } else {
            setView(targetView);
        }
    };

    return (
        <div className="container">
            <Header view={view} setView={navigateTo} />
            
            {showPassword && (
                <PasswordModal 
                    onSuccess={() => { setShowPassword(false); setView('admin'); }} 
                    onCancel={() => setShowPassword(false)} 
                />
            )}

            <main>
                {view === 'client' ? (
                    <ClientArea appointments={appointments} setAppointments={setAppointments} />
                ) : (
                    <AdminArea appointments={appointments} setAppointments={setAppointments} />
                )}
            </main>
        </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
