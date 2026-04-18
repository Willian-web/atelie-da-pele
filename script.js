document.addEventListener('DOMContentLoaded', () => {
    const taskForm = document.getElementById('task-form');
    const taskInput = document.getElementById('task-input');
    const taskList = document.getElementById('task-list');
    const taskCountStr = document.getElementById('task-count');
    
    let tasks = JSON.parse(localStorage.getItem('tasks')) || [];

    // Init
    renderTasks();

    // Events
    taskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = taskInput.value.trim();
        if (text) {
            addTask(text);
            taskInput.value = '';
            taskInput.focus();
        }
    });

    function saveTasks() {
        localStorage.setItem('tasks', JSON.stringify(tasks));
        updateStats();
    }

    function addTask(text) {
        const newTask = {
            id: Date.now().toString(),
            text: text,
            completed: false
        };
        tasks.push(newTask);
        saveTasks();
        renderTasks();
    }

    function toggleTask(id) {
        tasks = tasks.map(task => 
            task.id === id ? { ...task, completed: !task.completed } : task
        );
        saveTasks();
        renderTasks();
    }

    function deleteTask(id) {
        // Animação antes de remover
        const itemToRemove = document.getElementById(`task-${id}`);
        if(itemToRemove) {
            itemToRemove.style.transform = 'scale(0.9)';
            itemToRemove.style.opacity = '0';
            setTimeout(() => {
                tasks = tasks.filter(task => task.id !== id);
                saveTasks();
                renderTasks();
            }, 200);
        } else {
            tasks = tasks.filter(task => task.id !== id);
            saveTasks();
            renderTasks();
        }
    }

    function renderTasks() {
        taskList.innerHTML = '';
        
        if (tasks.length === 0) {
            taskList.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-clipboard-list"></i>
                    <p>Você não tem tarefas no momento.</p>
                </div>
            `;
            updateStats();
            return;
        }

        tasks.forEach(task => {
            const li = document.createElement('li');
            li.id = `task-${task.id}`;
            li.className = `task-item ${task.completed ? 'completed' : ''}`;
            li.style.transition = 'all 0.2s ease';
            
            li.innerHTML = `
                <input type="checkbox" class="task-checkbox" aria-label="Marcar como concluída" ${task.completed ? 'checked' : ''}>
                <span class="task-text">${escapeHTML(task.text)}</span>
                <button class="delete-btn" aria-label="Excluir tarefa" title="Excluir tarefa">
                    <i class="fas fa-trash-alt"></i>
                </button>
            `;

            // Event listeners
            const checkbox = li.querySelector('.task-checkbox');
            checkbox.addEventListener('change', () => toggleTask(task.id));

            const deleteBtn = li.querySelector('.delete-btn');
            deleteBtn.addEventListener('click', () => deleteTask(task.id));

            taskList.appendChild(li);
        });
        
        updateStats();
    }

    function updateStats() {
        if (!taskCountStr) return;
        const total = tasks.length;
        if (total === 0) {
            taskCountStr.textContent = 'Nenhuma tarefa';
        } else {
            const remaining = tasks.filter(t => !t.completed).length;
            if (remaining === 0) {
                taskCountStr.textContent = 'Todas as tarefas concluídas!';
            } else {
                taskCountStr.textContent = `${remaining} tarefa${remaining !== 1 ? 's' : ''} pendente${remaining !== 1 ? 's' : ''}`;
            }
        }
    }

    // Helper xss prev
    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
});
