/**
 * Scikit-Learner - Frontend JavaScript
 */

// Application State
const state = {
    data: null,
    columns: [],
    numericColumns: [],
    selectedFeatures: [],
    selectedTarget: null,
    trainedModels: {},
    selectedModelId: null,
    availableModels: {},
    selectedModelsToTrain: new Set(),
    taskType: null  // 'regression' or 'classification'
};

// All sample datasets with icons and type info
const ALL_DATASETS = [
    { key: 'iris', name: 'Iris Flowers', icon: '🌸', type: 'classification', samples: 150, features: 4, difficulty: 'Easy' },
    { key: 'airfoil', name: 'Airfoil Self-Noise', icon: '✈️', type: 'regression', samples: 1503, features: 5, difficulty: 'Medium' },
    { key: 'wine', name: 'Wine Quality', icon: '🍷', type: 'classification', samples: 178, features: 13, difficulty: 'Medium' },
    { key: 'diabetes', name: 'Diabetes', icon: '💊', type: 'regression', samples: 442, features: 10, difficulty: 'Medium' },
    { key: 'breast_cancer', name: 'Breast Cancer', icon: '🔬', type: 'classification', samples: 569, features: 30, difficulty: 'Medium' },
    { key: 'boston', name: 'Boston Housing', icon: '🏡', type: 'regression', samples: 506, features: 12, difficulty: 'Easy' },
    { key: 'digits', name: 'Digits', icon: '🔢', type: 'classification', samples: 1797, features: 64, difficulty: 'Hard' },
    { key: 'synthetic', name: 'Synthetic', icon: '📊', type: 'regression', samples: 500, features: 5, difficulty: 'Easy' }
];

// Legacy compatibility
const SAMPLE_DATASETS = {
    regression: ALL_DATASETS.filter(d => d.type === 'regression'),
    classification: ALL_DATASETS.filter(d => d.type === 'classification')
};

// Current filter state for home view
let currentTaskFilter = null;

// Initialize application — wait for Pyodide before any pyCall().
document.addEventListener('DOMContentLoaded', () => {
    initializePlots();
    setupEventListeners();
    if (window.pyodideReady && window.pyodideReady()) {
        loadAvailableModels();
    } else {
        window.addEventListener('pyodide-ready', () => loadAvailableModels(), { once: true });
    }
});

// Setup event listeners
function setupEventListeners() {
    document.getElementById('fileInput').addEventListener('change', handleFileSelect);

    // Plot type radio buttons
    document.querySelectorAll('input[name="plotType"]').forEach(radio => {
        radio.addEventListener('change', updatePlots);
    });

    // Tab changes
    document.querySelectorAll('#vizTabs button').forEach(tab => {
        tab.addEventListener('shown.bs.tab', () => {
            setTimeout(updatePlots, 100);
        });
    });
}

// Render datasets on home view
function renderHomeDatasets(filterType = null) {
    const container = document.getElementById('homeDatasetList');
    let datasets = ALL_DATASETS;

    if (filterType) {
        datasets = datasets.filter(d => d.type === filterType);
    }

    container.innerHTML = datasets.map(ds => `
        <div class="dataset-item" onclick="loadSampleDataset('${ds.key}')">
            <div class="dataset-icon">${ds.icon}</div>
            <div class="dataset-info">
                <div class="dataset-name">
                    ${ds.name}
                    <span class="type-badge ${ds.type}">${ds.type === 'regression' ? 'Regression' : 'Classification'}</span>
                </div>
                <div class="dataset-meta">
                    ${ds.samples.toLocaleString()} samples &bull; ${ds.features} features &bull;
                    <span class="${ds.difficulty === 'Easy' ? 'text-success' : ds.difficulty === 'Medium' ? 'text-warning' : 'text-danger'}">${ds.difficulty}</span>
                </div>
            </div>
            <div class="dataset-load">
                <i class="bi bi-arrow-right"></i>
            </div>
        </div>
    `).join('');
}

// Filter datasets by task type (called from task buttons)
function filterByTaskType(type) {
    currentTaskFilter = currentTaskFilter === type ? null : type;

    // Update button active states
    document.querySelectorAll('.task-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    if (currentTaskFilter) {
        document.querySelector(`.task-btn.${type}`).classList.add('active');
    }

    // Re-render datasets with filter
    renderHomeDatasets(currentTaskFilter);

    // Also load models for this task type
    if (currentTaskFilter) {
        loadAvailableModels(currentTaskFilter);
    }
}

// Toggle available models panel
function toggleModelsPanel() {
    const panel = document.getElementById('availableModels');
    const chevron = document.getElementById('modelsChevron');

    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        chevron.className = 'bi bi-chevron-up';
    } else {
        panel.style.display = 'none';
        chevron.className = 'bi bi-chevron-down';
    }
}

// Task Type Selection
function selectTaskType(taskType) {
    state.taskType = taskType;

    // Update UI to show sample datasets for this task type
    document.querySelector('.welcome-cards-container').style.display = 'none';
    document.getElementById('sampleDatasetsSection').style.display = 'block';
    document.getElementById('sampleDatasetsTitle').textContent =
        `${taskType === 'regression' ? 'Regression' : 'Classification'} Datasets`;

    // Render sample datasets
    renderSampleDatasets(taskType);

    // Update info bar task type badge
    const badge = document.getElementById('infoTaskType');
    badge.textContent = taskType === 'regression' ? 'Regression' : 'Classification';
    badge.className = taskType === 'regression'
        ? 'badge bg-primary me-2'
        : 'badge bg-warning me-2';
}

function clearTaskType() {
    state.taskType = null;
    document.querySelector('.welcome-cards-container').style.display = 'flex';
    document.getElementById('sampleDatasetsSection').style.display = 'none';
}

function renderSampleDatasets(taskType) {
    const container = document.getElementById('sampleDatasetsGrid');
    const datasets = SAMPLE_DATASETS[taskType] || [];

    container.innerHTML = datasets.map(ds => `
        <button class="list-group-item list-group-item-action" onclick="loadSampleDataset('${ds.key}')">
            <strong>${ds.name}</strong>
            <small class="d-block text-muted">${ds.samples.toLocaleString()} samples, ${ds.features} features - ${ds.description}</small>
        </button>
    `).join('');
}

function showWelcomeView() {
    document.getElementById('welcomeView').style.display = 'flex';
    document.getElementById('visualizationArea').style.display = 'none';
    document.getElementById('rightPanel').style.display = 'none';
}

function hideWelcomeView() {
    document.getElementById('welcomeView').style.display = 'none';
    document.getElementById('visualizationArea').style.display = 'flex';
    document.getElementById('rightPanel').style.display = 'block';

    // Update tabs based on task type
    updateTabsForTaskType();

    // Resize plots after display change (Plotly needs this)
    setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
    }, 100);
}

function updateTabsForTaskType() {
    const isClassification = state.taskType === 'classification';

    // Show/hide regression-specific tabs
    document.querySelectorAll('.regression-tab').forEach(tab => {
        tab.style.display = isClassification ? 'none' : '';
    });

    // Show/hide classification-specific tabs
    document.querySelectorAll('.classification-tab').forEach(tab => {
        tab.style.display = isClassification ? '' : 'none';
    });

    // Update metrics tables
    document.querySelectorAll('.regression-metrics').forEach(el => {
        el.style.display = isClassification ? 'none' : '';
    });
    document.querySelectorAll('.classification-metrics').forEach(el => {
        el.style.display = isClassification ? '' : 'none';
    });
}

// Load available models (Pyodide port — calls Python directly)
async function loadAvailableModels(taskType = null) {
    try {
        if (!taskType && !state.taskType) {
            const [regData, classData] = await Promise.all([
                pyCall('available_models', ['regression']),
                pyCall('available_models', ['classification']),
            ]);
            state.availableModels = { regression: regData.models, classification: classData.models };
            renderAvailableModelsBothTypes();
        } else {
            const type = taskType || state.taskType || 'regression';
            const data = await pyCall('available_models', [type]);
            state.availableModels = data.models;
            renderAvailableModels();
        }
    } catch (error) {
        console.error('Error loading models:', error);
    }
}

// Render available models in sidebar (single task type)
function renderAvailableModels() {
    const container = document.getElementById('availableModels');
    container.innerHTML = '';

    let totalCount = 0;
    const taskType = state.taskType || currentTaskFilter || 'regression';
    const taskLabel = taskType === 'classification' ? 'Classification' : 'Regression';

    for (const [category, models] of Object.entries(state.availableModels)) {
        totalCount += models.length;

        const categoryEl = document.createElement('div');
        categoryEl.className = 'model-category';
        categoryEl.textContent = category;
        container.appendChild(categoryEl);

        models.forEach(model => {
            const modelEl = document.createElement('div');
            modelEl.className = 'available-model-item';
            modelEl.innerHTML = `
                <input type="checkbox" id="model_${model.key}" value="${model.key}"
                    onchange="toggleModelSelection('${model.key}')">
                <label for="model_${model.key}" style="cursor: pointer; margin: 0; flex: 1;">
                    ${model.name}
                </label>
            `;
            container.appendChild(modelEl);
        });
    }

    // Update count badge
    const badge = document.getElementById('modelCountBadge');
    badge.textContent = `${totalCount} ${taskLabel}`;
    badge.className = taskType === 'classification' ? 'badge bg-warning' : 'badge bg-primary';
}

// Render available models for both types (before data is loaded)
function renderAvailableModelsBothTypes() {
    const container = document.getElementById('availableModels');
    container.innerHTML = '';

    let regCount = 0;
    let classCount = 0;

    // Render regression models
    const regModels = state.availableModels.regression || {};
    for (const [category, models] of Object.entries(regModels)) {
        regCount += models.length;

        const categoryEl = document.createElement('div');
        categoryEl.className = 'model-category';
        categoryEl.innerHTML = `${category} <span class="task-tag regression">Regression</span>`;
        container.appendChild(categoryEl);

        models.forEach(model => {
            const modelEl = document.createElement('div');
            modelEl.className = 'available-model-item';
            modelEl.innerHTML = `
                <input type="checkbox" id="model_${model.key}" value="${model.key}" disabled>
                <label for="model_${model.key}" style="cursor: pointer; margin: 0; flex: 1; opacity: 0.7;">
                    ${model.name}
                </label>
            `;
            container.appendChild(modelEl);
        });
    }

    // Render classification models
    const classModels = state.availableModels.classification || {};
    for (const [category, models] of Object.entries(classModels)) {
        classCount += models.length;

        const categoryEl = document.createElement('div');
        categoryEl.className = 'model-category';
        categoryEl.innerHTML = `${category} <span class="task-tag classification">Classification</span>`;
        container.appendChild(categoryEl);

        models.forEach(model => {
            const modelEl = document.createElement('div');
            modelEl.className = 'available-model-item';
            modelEl.innerHTML = `
                <input type="checkbox" id="model_${model.key}" value="${model.key}" disabled>
                <label for="model_${model.key}" style="cursor: pointer; margin: 0; flex: 1; opacity: 0.7;">
                    ${model.name}
                </label>
            `;
            container.appendChild(modelEl);
        });
    }

    // Update count badge
    const badge = document.getElementById('modelCountBadge');
    badge.textContent = `${regCount + classCount}`;
    badge.className = 'badge bg-secondary';
}

// Toggle model selection for training
function toggleModelSelection(modelKey) {
    if (state.selectedModelsToTrain.has(modelKey)) {
        state.selectedModelsToTrain.delete(modelKey);
    } else {
        state.selectedModelsToTrain.add(modelKey);
    }
    updateTrainButtons();
}

// Update train button states
function updateTrainButtons() {
    const hasData = state.data !== null;
    const hasTarget = state.selectedTarget !== null;
    const hasFeatures = state.selectedFeatures.length > 0;
    const hasSelectedModels = state.selectedModelsToTrain.size > 0;

    document.getElementById('trainBtn').disabled = !(hasData && hasTarget && hasFeatures && hasSelectedModels);
    document.getElementById('trainAllBtn').disabled = !(hasData && hasTarget && hasFeatures);
}

// Show new data modal (unified)
function showNewDataModal() {
    renderModalDatasets();
    document.getElementById('uploadSection').style.display = 'none';
    const modal = new bootstrap.Modal(document.getElementById('newDataModal'));
    modal.show();
}

// Render datasets in modal
function renderModalDatasets() {
    const container = document.getElementById('modalDatasetList');
    container.innerHTML = ALL_DATASETS.map(ds => `
        <div class="modal-dataset-item" onclick="loadSampleDataset('${ds.key}')">
            <div class="modal-dataset-icon">${ds.icon}</div>
            <div class="modal-dataset-info">
                <div class="modal-dataset-name">
                    ${ds.name}
                    <span class="type-badge ${ds.type}">${ds.type === 'regression' ? 'Regression' : 'Classification'}</span>
                </div>
                <div class="modal-dataset-meta">
                    ${ds.samples.toLocaleString()} rows &bull;
                    <span class="${ds.difficulty === 'Easy' ? 'text-success' : ds.difficulty === 'Medium' ? 'text-warning' : 'text-danger'}">${ds.difficulty}</span>
                </div>
            </div>
        </div>
    `).join('');
}

// Show upload section in modal
function showUploadSection() {
    const section = document.getElementById('uploadSection');
    section.style.display = section.style.display === 'none' ? 'block' : 'none';
}

// Legacy functions for compatibility
function openFileUpload() {
    showNewDataModal();
    setTimeout(() => showUploadSection(), 100);
}

function showSampleDatasets() {
    showNewDataModal();
}

// Handle file selection
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const text = e.target.result;
            previewCSV(text);
        };
        reader.readAsText(file);
    }
}

// Preview CSV data
function previewCSV(text) {
    const lines = text.split('\n').slice(0, 6);
    const headers = lines[0].split(',');

    let tableHTML = '<thead><tr>';
    headers.forEach(h => tableHTML += `<th>${h.trim()}</th>`);
    tableHTML += '</tr></thead><tbody>';

    lines.slice(1).forEach(line => {
        if (line.trim()) {
            tableHTML += '<tr>';
            line.split(',').forEach(cell => tableHTML += `<td>${cell.trim()}</td>`);
            tableHTML += '</tr>';
        }
    });
    tableHTML += '</tbody>';

    document.getElementById('previewTable').innerHTML = tableHTML;
    document.getElementById('uploadPreview').style.display = 'block';
}

// Upload file to server
async function uploadFile() {
    const fileInput = document.getElementById('fileInput');
    if (!fileInput.files[0]) {
        alert('Please select a file first');
        return;
    }

    showLoading();
    try {
        const file = fileInput.files[0];
        if (file.size > 20 * 1024 * 1024) {
            throw new Error('File exceeds 20 MB cap — Pyodide runs out of memory on large CSVs.');
        }
        const buf = new Uint8Array(await file.arrayBuffer());
        const data = await pyCallBinary('upload_csv', buf, [file.name]);
        handleDataLoaded(data);

        const modal = bootstrap.Modal.getInstance(document.getElementById('newDataModal'));
        if (modal) modal.hide();
    } catch (error) {
        alert('Error uploading file: ' + error.message);
    } finally {
        hideLoading();
    }
}

// Load sample dataset (Pyodide)
async function loadSampleDataset(datasetKey) {
    showLoading();
    try {
        const data = await pyCall('load_sample', [datasetKey]);
        handleDataLoaded(data);

        const modal = bootstrap.Modal.getInstance(document.getElementById('newDataModal'));
        if (modal) modal.hide();
    } catch (error) {
        alert('Error loading dataset: ' + error.message);
    } finally {
        hideLoading();
    }
}

// Handle data loaded
function handleDataLoaded(data) {
    state.data = data;
    state.columns = data.columns;
    state.numericColumns = data.numeric_columns;
    state.trainedModels = {};
    state.selectedModelId = null;

    // Set task type if provided by backend
    if (data.task_type) {
        state.taskType = data.task_type;
    }

    // Update UI
    document.getElementById('dataStatus').textContent = `${data.filename} (${data.stats.rows} rows)`;
    document.getElementById('dataStatus').className = 'badge bg-success';

    // Populate feature selectors
    populateSelectors();

    // Update info bar
    document.getElementById('infoDataset').textContent = `Data set: ${data.filename}`;
    document.getElementById('infoObs').textContent = `Observations: ${data.stats.rows}`;
    document.getElementById('infoFeatures').textContent = `Features: ${state.numericColumns.length}`;

    // Update task type badge
    const badge = document.getElementById('infoTaskType');
    badge.textContent = state.taskType === 'classification' ? 'Classification' : 'Regression';
    badge.className = state.taskType === 'classification'
        ? 'badge bg-warning me-2'
        : 'badge bg-primary me-2';

    // Clear previous models
    renderTrainedModels();

    // Reload available models for current task type
    loadAvailableModels(state.taskType);

    // Hide welcome view and show visualization area
    hideWelcomeView();

    // Show feature selection modal
    showFeatureSelection();

    // Fetch and show basic data visualization
    fetchDataPreview();
}

// Fetch data preview for basic visualization (Pyodide)
async function fetchDataPreview() {
    try {
        const preview = await pyCall('data_preview', []);
        state.dataPreview = preview;
        showDataPlots();
    } catch (error) {
        console.error('Error fetching data preview:', error);
    }
}

// Show basic data plots (before model training)
function showDataPlots() {
    if (!state.dataPreview) return;

    const data = state.dataPreview.data;
    const columns = state.dataPreview.columns;

    // Get selected axes or use first two columns
    const xCol = document.getElementById('xAxisSelect').value || columns[0];
    const yCol = document.getElementById('yAxisSelect').value || (columns.length > 1 ? columns[1] : columns[0]);
    const targetCol = state.selectedTarget || 'target';

    // Create scatter plot of data
    const xData = data[xCol] || [];
    const yData = data[yCol] || [];
    const colorData = data[targetCol] || xData;

    const scatterTrace = {
        x: xData,
        y: yData,
        mode: 'markers',
        type: 'scatter',
        marker: {
            color: colorData,
            colorscale: 'Viridis',
            showscale: true,
            colorbar: { title: targetCol },
            size: 6,
            opacity: 0.7
        },
        name: 'Data'
    };

    const scatterLayout = {
        title: `Data Preview: ${xCol} vs ${yCol}`,
        xaxis: { title: xCol },
        yaxis: { title: yCol },
        margin: { t: 50, r: 80, b: 50, l: 60 },
        hovermode: 'closest'
    };

    Plotly.react('scatterPlot', [scatterTrace], scatterLayout, { responsive: true });

    // Create a distribution/histogram for the target
    if (data[targetCol]) {
        const histTrace = {
            x: data[targetCol],
            type: 'histogram',
            marker: { color: '#0d6efd' },
            name: 'Distribution'
        };

        const histLayout = {
            title: `Target Distribution: ${targetCol}`,
            xaxis: { title: targetCol },
            yaxis: { title: 'Count' },
            margin: { t: 50, r: 20, b: 50, l: 60 },
            bargap: 0.05
        };

        Plotly.react('predictedPlot', [histTrace], histLayout, { responsive: true });
    }

    // Show empty placeholder for comparison (no models yet)
    const emptyLayout = {
        title: 'Train models to compare performance',
        xaxis: { title: '', showgrid: false, zeroline: false, showticklabels: false },
        yaxis: { title: '', showgrid: false, zeroline: false, showticklabels: false },
        margin: { t: 50, r: 20, b: 50, l: 60 },
        annotations: [{
            text: 'No models trained yet.<br>Select models and click "Train" to begin.',
            xref: 'paper',
            yref: 'paper',
            x: 0.5,
            y: 0.5,
            showarrow: false,
            font: { size: 14, color: '#6c757d' }
        }]
    };

    Plotly.react('comparisonPlot', [], emptyLayout, { responsive: true });
    Plotly.react('residualsPlot', [], emptyLayout, { responsive: true });
    Plotly.react('confusionPlot', [], emptyLayout, { responsive: true });
    Plotly.react('rocPlot', [], emptyLayout, { responsive: true });
}

// Populate axis selectors
function populateSelectors() {
    const xSelect = document.getElementById('xAxisSelect');
    const ySelect = document.getElementById('yAxisSelect');
    const targetSelect = document.getElementById('targetSelect');

    // Clear existing options
    xSelect.innerHTML = '<option value="">Select feature...</option>';
    ySelect.innerHTML = '<option value="">Select feature...</option>';
    targetSelect.innerHTML = '<option value="">Select target...</option>';

    // Add numeric columns
    state.numericColumns.forEach(col => {
        xSelect.add(new Option(col, col));
        ySelect.add(new Option(col, col));
        targetSelect.add(new Option(col, col));
    });

    // Set default values if target column exists
    if (state.numericColumns.includes('target')) {
        targetSelect.value = 'target';
        state.selectedTarget = 'target';

        // Set default features (exclude target)
        const features = state.numericColumns.filter(c => c !== 'target');
        if (features.length >= 2) {
            xSelect.value = features[0];
            ySelect.value = features[1];
        }
    }
}

// Show feature selection modal
function showFeatureSelection() {
    const container = document.getElementById('featureCheckboxes');
    container.innerHTML = '';

    state.numericColumns.forEach(col => {
        const isTarget = col === state.selectedTarget || col === 'target';
        const div = document.createElement('div');
        div.className = 'form-check';
        div.innerHTML = `
            <input class="form-check-input feature-checkbox" type="checkbox" value="${col}"
                id="feature_${col}" ${!isTarget ? 'checked' : ''}>
            <label class="form-check-label" for="feature_${col}">${col}</label>
        `;
        container.appendChild(div);
    });

    const modal = new bootstrap.Modal(document.getElementById('featureModal'));
    modal.show();
}

// Select all features
function selectAllFeatures() {
    document.querySelectorAll('.feature-checkbox').forEach(cb => {
        if (cb.value !== state.selectedTarget) {
            cb.checked = true;
        }
    });
}

// Deselect all features
function deselectAllFeatures() {
    document.querySelectorAll('.feature-checkbox').forEach(cb => cb.checked = false);
}

// Confirm feature selection
function confirmFeatureSelection() {
    state.selectedFeatures = [];
    document.querySelectorAll('.feature-checkbox:checked').forEach(cb => {
        state.selectedFeatures.push(cb.value);
    });

    if (state.selectedFeatures.length === 0) {
        alert('Please select at least one feature');
        return;
    }

    bootstrap.Modal.getInstance(document.getElementById('featureModal')).hide();
    document.getElementById('infoFeatures').textContent = `Features: ${state.selectedFeatures.length}/${state.numericColumns.length}`;
    updateTrainButtons();
}

// On target change
function onTargetChange() {
    state.selectedTarget = document.getElementById('targetSelect').value;
    document.getElementById('infoTarget').textContent = `Target: ${state.selectedTarget || '-'}`;

    // Update feature selection to exclude target
    state.selectedFeatures = state.selectedFeatures.filter(f => f !== state.selectedTarget);
    updateTrainButtons();
}

// Train selected models
async function trainSelectedModels() {
    if (state.selectedModelsToTrain.size === 0) {
        alert('Please select at least one model to train');
        return;
    }

    const modelsToTrain = Array.from(state.selectedModelsToTrain);
    await trainModels(modelsToTrain);
}

// Train all available models
async function trainAllModels() {
    const allModels = [];
    for (const models of Object.values(state.availableModels)) {
        models.forEach(m => allModels.push(m.key));
    }
    await trainModels(allModels);
}

// Train models
async function trainModels(modelKeys) {
    showLoading();
    const cvFolds = parseInt(document.getElementById('cvFolds').value);

    let completed = 0;
    const total = modelKeys.length;

    for (const modelKey of modelKeys) {
        try {
            const result = await pyCall('train', [
                modelKey,
                state.selectedFeatures,
                state.selectedTarget,
                cvFolds,
                state.taskType || 'regression',
            ]);
            // Use modelKey as the key to prevent duplicates when retraining
            state.trainedModels[modelKey] = { ...result, type: modelKey };
        } catch (error) {
            console.error(`Error training ${modelKey}:`, error);
        }

        completed++;
    }

    renderTrainedModels();
    hideLoading();

    // Auto-select best model
    selectBestModel();
}

// Select best performing model
function selectBestModel() {
    let bestModel = null;
    let bestScore = -Infinity;

    const metricKey = state.taskType === 'classification' ? 'cv_accuracy_mean' : 'cv_r2_mean';

    for (const [id, model] of Object.entries(state.trainedModels)) {
        const score = model.metrics[metricKey] || 0;
        if (score > bestScore) {
            bestScore = score;
            bestModel = id;
        }
    }

    if (bestModel) {
        selectModel(bestModel);
    }
}

// Render trained models list
function renderTrainedModels() {
    const container = document.getElementById('modelList');

    if (Object.keys(state.trainedModels).length === 0) {
        container.innerHTML = `
            <div class="text-muted small p-3 text-center">
                Load data and select features to start training models
            </div>
        `;
        return;
    }

    const isClassification = state.taskType === 'classification';
    const metricKey = isClassification ? 'cv_accuracy_mean' : 'cv_r2_mean';

    // Sort models by CV score
    const sortedModels = Object.entries(state.trainedModels)
        .sort((a, b) => (b[1].metrics[metricKey] || 0) - (a[1].metrics[metricKey] || 0));

    container.innerHTML = '';

    sortedModels.forEach(([id, model], index) => {
        const score = model.metrics[metricKey] || 0;
        let scoreClass = 'model-score';
        if (score < 0.5) scoreClass += ' poor';
        else if (score < 0.8) scoreClass += ' medium';

        const categoryClass = model.category.toLowerCase().replace(/\s+/g, '');

        const modelEl = document.createElement('div');
        modelEl.className = `model-item ${id === state.selectedModelId ? 'selected' : ''}`;
        modelEl.onclick = () => selectModel(id);

        if (isClassification) {
            const f1 = model.metrics.f1 || 0;
            modelEl.innerHTML = `
                <div class="model-name">
                    <span class="category-badge ${categoryClass}">${model.category}</span>
                    ${model.model_name}
                </div>
                <div class="model-meta">
                    <span class="${scoreClass}">Acc: ${(score * 100).toFixed(1)}%</span>
                    &nbsp;|&nbsp; F1: ${(f1 * 100).toFixed(1)}%
                </div>
            `;
        } else {
            modelEl.innerHTML = `
                <div class="model-name">
                    <span class="category-badge ${categoryClass}">${model.category}</span>
                    ${model.model_name}
                </div>
                <div class="model-meta">
                    <span class="${scoreClass}">R<sup>2</sup>: ${(score * 100).toFixed(1)}%</span>
                    &nbsp;|&nbsp; RMSE: ${model.metrics.rmse.toFixed(3)}
                </div>
            `;
        }
        container.appendChild(modelEl);
    });

    document.getElementById('exportBtn').disabled = Object.keys(state.trainedModels).length === 0;
}

// Sort models
function sortModels(by) {
    const container = document.getElementById('modelList');
    const models = Array.from(container.querySelectorAll('.model-item'));

    models.sort((a, b) => {
        if (by === 'name') {
            return a.querySelector('.model-name').textContent.localeCompare(
                b.querySelector('.model-name').textContent
            );
        } else {
            const scoreA = parseFloat(a.querySelector('.model-score').textContent.match(/[\d.]+/)[0]);
            const scoreB = parseFloat(b.querySelector('.model-score').textContent.match(/[\d.]+/)[0]);
            return scoreB - scoreA;
        }
    });

    container.innerHTML = '';
    models.forEach(m => container.appendChild(m));
}

// Select a model
async function selectModel(modelId) {
    state.selectedModelId = modelId;

    // Update UI
    document.querySelectorAll('.model-item').forEach(el => el.classList.remove('selected'));
    document.querySelector(`.model-item[onclick="selectModel('${modelId}')"]`)?.classList.add('selected');

    // Update metrics panel
    const model = state.trainedModels[modelId];
    document.getElementById('modelMetrics').style.display = 'block';

    if (state.taskType === 'classification') {
        // Classification metrics
        document.getElementById('metricAccuracy').textContent = (model.metrics.accuracy * 100).toFixed(2) + '%';
        document.getElementById('metricF1').textContent = (model.metrics.f1 * 100).toFixed(2) + '%';
        document.getElementById('metricPrecision').textContent = (model.metrics.precision * 100).toFixed(2) + '%';
        document.getElementById('metricRecall').textContent = (model.metrics.recall * 100).toFixed(2) + '%';
        document.getElementById('metricCVAccuracy').textContent = (model.metrics.cv_accuracy_mean * 100).toFixed(2) + '%';
    } else {
        // Regression metrics
        document.getElementById('metricR2').textContent = (model.metrics.r2 * 100).toFixed(2) + '%';
        document.getElementById('metricRMSE').textContent = model.metrics.rmse.toFixed(4);
        document.getElementById('metricMAE').textContent = model.metrics.mae.toFixed(4);
        document.getElementById('metricCVR2').textContent = (model.metrics.cv_r2_mean * 100).toFixed(2) + '%';
    }

    // Fetch predictions and update plots
    await fetchPredictionsAndUpdatePlots(modelId);
}

// Fetch predictions and update plots (Pyodide)
async function fetchPredictionsAndUpdatePlots(modelKey) {
    try {
        const model = state.trainedModels[modelKey];
        if (!model) return;

        const data = await pyCall('predictions', [model.model_id]);
        state.trainedModels[modelKey].predictions = data.predictions;
        state.trainedModels[modelKey].actual = data.actual;

        if (data.residuals) state.trainedModels[modelKey].residuals = data.residuals;
        if (data.confusion_matrix) state.trainedModels[modelKey].confusion_matrix = data.confusion_matrix;
        if (data.roc_curve) state.trainedModels[modelKey].roc_curve = data.roc_curve;
        if (data.class_labels) state.trainedModels[modelKey].class_labels = data.class_labels;

        updatePlots();
    } catch (error) {
        console.error('Error fetching predictions:', error);
    }
}

// Initialize empty plots
function initializePlots() {
    const emptyLayout = {
        title: 'Load data to begin',
        xaxis: { title: '' },
        yaxis: { title: '' },
        margin: { t: 40, r: 20, b: 40, l: 50 }
    };

    Plotly.newPlot('scatterPlot', [], emptyLayout, { responsive: true });
    Plotly.newPlot('residualsPlot', [], emptyLayout, { responsive: true });
    Plotly.newPlot('predictedPlot', [], emptyLayout, { responsive: true });
    Plotly.newPlot('comparisonPlot', [], emptyLayout, { responsive: true });
    Plotly.newPlot('confusionPlot', [], emptyLayout, { responsive: true });
    Plotly.newPlot('rocPlot', [], emptyLayout, { responsive: true });
}

// Update all plots
function updatePlots() {
    // If no model selected, show data preview plots
    if (!state.selectedModelId || !state.trainedModels[state.selectedModelId]) {
        if (state.dataPreview) {
            showDataPlots();
        }
        return;
    }

    const model = state.trainedModels[state.selectedModelId];
    if (!model.predictions) return;

    updateScatterPlot(model);
    updateComparisonPlot();

    if (state.taskType === 'classification') {
        updateConfusionMatrixPlot(model);
        updateROCPlot(model);
        updatePredictedVsActualPlotClassification(model);
    } else {
        updateResidualsPlot(model);
        updatePredictedVsActualPlot(model);
    }
}

// Update scatter plot
function updateScatterPlot(model) {
    const xFeature = document.getElementById('xAxisSelect').value || state.selectedFeatures[0];
    const yFeature = document.getElementById('yAxisSelect').value ||
        (state.selectedFeatures.length > 1 ? state.selectedFeatures[1] : state.selectedFeatures[0]);

    if (!xFeature) return;

    const xIdx = state.selectedFeatures.indexOf(xFeature);
    const yIdx = state.selectedFeatures.indexOf(yFeature);

    // Get data from preview (we need to refetch for full data)
    const plotType = document.querySelector('input[name="plotType"]:checked').value;

    let colorScale;
    if (plotType === 'predictions') {
        colorScale = model.predictions;
    } else {
        colorScale = model.actual;
    }

    // Create trace using predictions vs actual for coloring
    const trace = {
        x: model.actual.map((_, i) => i), // Index as x for now
        y: model.actual,
        mode: 'markers',
        type: 'scatter',
        marker: {
            color: colorScale,
            colorscale: 'Viridis',
            showscale: true,
            colorbar: { title: plotType === 'predictions' ? 'Predicted' : 'Actual' }
        },
        name: 'Data'
    };

    const layout = {
        title: `${model.model_name} - ${plotType === 'predictions' ? 'Predictions' : 'Data'}`,
        xaxis: { title: 'Sample Index' },
        yaxis: { title: state.selectedTarget },
        margin: { t: 50, r: 80, b: 50, l: 60 },
        hovermode: 'closest'
    };

    Plotly.react('scatterPlot', [trace], layout, { responsive: true });
}

// Update residuals plot
function updateResidualsPlot(model) {
    const residuals = model.residuals;
    const predictions = model.predictions;

    const trace = {
        x: predictions,
        y: residuals,
        mode: 'markers',
        type: 'scatter',
        marker: {
            color: residuals.map(r => Math.abs(r)),
            colorscale: 'RdYlGn',
            reversescale: true,
            showscale: true,
            colorbar: { title: '|Residual|' }
        },
        name: 'Residuals'
    };

    // Zero line
    const zeroLine = {
        x: [Math.min(...predictions), Math.max(...predictions)],
        y: [0, 0],
        mode: 'lines',
        type: 'scatter',
        line: { color: 'red', dash: 'dash' },
        name: 'Zero Line'
    };

    const layout = {
        title: `${model.model_name} - Residuals Plot`,
        xaxis: { title: 'Predicted Values' },
        yaxis: { title: 'Residuals' },
        margin: { t: 50, r: 80, b: 50, l: 60 },
        showlegend: false
    };

    Plotly.react('residualsPlot', [trace, zeroLine], layout, { responsive: true });
}

// Update predicted vs actual plot
function updatePredictedVsActualPlot(model) {
    const actual = model.actual;
    const predicted = model.predictions;

    const trace = {
        x: actual,
        y: predicted,
        mode: 'markers',
        type: 'scatter',
        marker: {
            color: '#0d6efd',
            opacity: 0.6
        },
        name: 'Predictions'
    };

    // Perfect prediction line
    const minVal = Math.min(...actual, ...predicted);
    const maxVal = Math.max(...actual, ...predicted);
    const perfectLine = {
        x: [minVal, maxVal],
        y: [minVal, maxVal],
        mode: 'lines',
        type: 'scatter',
        line: { color: 'red', dash: 'dash' },
        name: 'Perfect Prediction'
    };

    const layout = {
        title: `${model.model_name} - Predicted vs Actual (R<sup>2</sup>: ${(model.metrics.r2 * 100).toFixed(1)}%)`,
        xaxis: { title: 'Actual Values' },
        yaxis: { title: 'Predicted Values' },
        margin: { t: 50, r: 20, b: 50, l: 60 },
        showlegend: true,
        legend: { x: 0.02, y: 0.98 }
    };

    Plotly.react('predictedPlot', [trace, perfectLine], layout, { responsive: true });
}

// Update comparison plot
function updateComparisonPlot() {
    if (Object.keys(state.trainedModels).length === 0) return;

    const isClassification = state.taskType === 'classification';
    const metricKey = isClassification ? 'cv_accuracy_mean' : 'cv_r2_mean';
    const metricLabel = isClassification ? 'Accuracy' : 'R<sup>2</sup>';

    const models = Object.values(state.trainedModels)
        .sort((a, b) => (b.metrics[metricKey] || 0) - (a.metrics[metricKey] || 0));

    const names = models.map(m => m.model_name);
    const scores = models.map(m => (m.metrics[metricKey] || 0) * 100);
    const colors = models.map(m => {
        const score = m.metrics[metricKey] || 0;
        if (score >= 0.8) return '#198754';
        if (score >= 0.5) return '#ffc107';
        return '#dc3545';
    });

    const trace = {
        x: scores,
        y: names,
        type: 'bar',
        orientation: 'h',
        marker: { color: colors },
        text: scores.map(s => s.toFixed(1) + '%'),
        textposition: 'outside'
    };

    const layout = {
        title: `Model Comparison (Cross-Validation ${metricLabel})`,
        xaxis: {
            title: `${metricLabel} Score (%)`,
            range: [0, Math.max(100, Math.max(...scores) + 10)]
        },
        yaxis: {
            automargin: true
        },
        margin: { t: 50, r: 80, b: 50, l: 150 },
        showlegend: false
    };

    Plotly.react('comparisonPlot', [trace], layout, { responsive: true });
}

// Classification-specific plots
function updateConfusionMatrixPlot(model) {
    if (!model.confusion_matrix) return;

    const cm = model.confusion_matrix;
    const labels = model.class_labels || cm.map((_, i) => `Class ${i}`);

    const trace = {
        z: cm,
        x: labels,
        y: labels,
        type: 'heatmap',
        colorscale: 'Blues',
        showscale: true,
        text: cm.map(row => row.map(val => val.toString())),
        texttemplate: '%{text}',
        textfont: { size: 14 },
        hoverongaps: false
    };

    const layout = {
        title: `${model.model_name} - Confusion Matrix`,
        xaxis: { title: 'Predicted', side: 'bottom' },
        yaxis: { title: 'Actual', autorange: 'reversed' },
        margin: { t: 50, r: 50, b: 80, l: 80 }
    };

    Plotly.react('confusionPlot', [trace], layout, { responsive: true });
}

function updateROCPlot(model) {
    if (!model.roc_curve) return;

    const traces = [];

    // Handle multi-class ROC (one curve per class)
    if (Array.isArray(model.roc_curve.fpr[0])) {
        model.roc_curve.fpr.forEach((fpr, i) => {
            traces.push({
                x: fpr,
                y: model.roc_curve.tpr[i],
                mode: 'lines',
                name: `Class ${i} (AUC: ${(model.roc_curve.auc[i] || 0).toFixed(3)})`,
                line: { width: 2 }
            });
        });
    } else {
        // Binary classification
        traces.push({
            x: model.roc_curve.fpr,
            y: model.roc_curve.tpr,
            mode: 'lines',
            name: `ROC (AUC: ${(model.roc_curve.auc || 0).toFixed(3)})`,
            line: { color: '#0d6efd', width: 2 }
        });
    }

    // Diagonal reference line
    traces.push({
        x: [0, 1],
        y: [0, 1],
        mode: 'lines',
        name: 'Random',
        line: { color: 'gray', dash: 'dash', width: 1 }
    });

    const layout = {
        title: `${model.model_name} - ROC Curve`,
        xaxis: { title: 'False Positive Rate', range: [0, 1] },
        yaxis: { title: 'True Positive Rate', range: [0, 1] },
        margin: { t: 50, r: 20, b: 50, l: 60 },
        showlegend: true,
        legend: { x: 0.6, y: 0.1 }
    };

    Plotly.react('rocPlot', traces, layout, { responsive: true });
}

function updatePredictedVsActualPlotClassification(model) {
    const actual = model.actual;
    const predicted = model.predictions;

    // For classification, show a grouped bar chart of actual vs predicted class distributions
    const actualCounts = {};
    const predictedCounts = {};
    const labels = model.class_labels || [...new Set([...actual, ...predicted])].sort();

    labels.forEach(l => {
        actualCounts[l] = 0;
        predictedCounts[l] = 0;
    });

    actual.forEach(v => actualCounts[v] = (actualCounts[v] || 0) + 1);
    predicted.forEach(v => predictedCounts[v] = (predictedCounts[v] || 0) + 1);

    const traceActual = {
        x: labels,
        y: labels.map(l => actualCounts[l]),
        type: 'bar',
        name: 'Actual',
        marker: { color: '#0d6efd' }
    };

    const tracePredicted = {
        x: labels,
        y: labels.map(l => predictedCounts[l]),
        type: 'bar',
        name: 'Predicted',
        marker: { color: '#198754' }
    };

    const layout = {
        title: `${model.model_name} - Class Distribution`,
        xaxis: { title: 'Class' },
        yaxis: { title: 'Count' },
        barmode: 'group',
        margin: { t: 50, r: 20, b: 50, l: 60 },
        showlegend: true,
        legend: { x: 0.02, y: 0.98 }
    };

    Plotly.react('predictedPlot', [traceActual, tracePredicted], layout, { responsive: true });
}

// Show export modal
function exportSelectedModel() {
    const trainedModelKeys = Object.keys(state.trainedModels);
    if (trainedModelKeys.length === 0) {
        alert('No models trained yet');
        return;
    }

    renderExportModelList();
    const modal = new bootstrap.Modal(document.getElementById('exportModal'));
    modal.show();
}

// Render export model list
function renderExportModelList() {
    const container = document.getElementById('exportModelList');
    const isClassification = state.taskType === 'classification';
    const metricKey = isClassification ? 'cv_accuracy_mean' : 'cv_r2_mean';
    const metricLabel = isClassification ? 'Accuracy' : 'R²';

    container.innerHTML = Object.entries(state.trainedModels).map(([key, model]) => {
        const score = ((model.metrics[metricKey] || 0) * 100).toFixed(1);
        return `
            <div class="export-model-item">
                <input type="checkbox" id="export_${key}" value="${key}" class="export-checkbox" checked>
                <div class="model-info">
                    <div class="model-name">${model.model_name}</div>
                    <div class="model-score">${metricLabel}: ${score}%</div>
                </div>
            </div>
        `;
    }).join('');
}

// Select/deselect all export models
function selectAllExportModels() {
    document.querySelectorAll('.export-checkbox').forEach(cb => cb.checked = true);
}

function deselectAllExportModels() {
    document.querySelectorAll('.export-checkbox').forEach(cb => cb.checked = false);
}

// Download selected models
async function downloadSelectedModels() {
    const selectedKeys = [];
    document.querySelectorAll('.export-checkbox:checked').forEach(cb => {
        selectedKeys.push(cb.value);
    });

    if (selectedKeys.length === 0) {
        alert('Please select at least one model');
        return;
    }

    // Get backend model_ids for selected models
    const modelIds = selectedKeys.map(key => state.trainedModels[key].model_id);

    showLoading();
    try {
        const bytes = await pyCall('bulk_zip', [modelIds]);
        // Pyodide returns a JS Uint8Array (or proxy that toJs'd to one).
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const single = modelIds.length === 1;
        const filename = single
            ? `${state.trainedModels[selectedKeys[0]].type}.joblib`
            : 'models.zip';
        const mime = single ? 'application/octet-stream' : 'application/zip';
        downloadBytes(u8, filename, mime);

        bootstrap.Modal.getInstance(document.getElementById('exportModal')).hide();
    } catch (error) {
        alert('Error downloading models: ' + error.message);
    } finally {
        hideLoading();
    }
}

// Navigation functions
function showDataSection() {
    showFeatureSelection();
}

function showLearnSection() {
    document.getElementById('scatter-tab').click();
}

function showCompareSection() {
    document.getElementById('comparison-tab').click();
    updateComparisonPlot();
}

// Loading overlay
function showLoading() {
    let overlay = document.querySelector('.loading-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'loading-overlay';
        overlay.innerHTML = '<div class="loading-spinner"></div>';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
}

function hideLoading() {
    const overlay = document.querySelector('.loading-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}
