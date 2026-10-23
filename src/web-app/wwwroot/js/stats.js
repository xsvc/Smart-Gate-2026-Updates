// Builds the Stats page tables and chart from the database (GET /api/stats)

const STAT_LABELS = [
    { key: "total_animals", label: "Total Animals" },
    { key: "total_threats", label: "Total Threats" },
    { key: "total_endangered", label: "Total Endangered" },
    { key: "total_threats_and_endangered", label: "Threats & Endangered" },
    { key: "percent_threats", label: "% Threats", percent: true },
    { key: "percent_endangered", label: "% Endangered", percent: true },
    { key: "percent_both", label: "% Both", percent: true },
];

// Black rows with white bold text, as on the original page
function rowFormatter(row) {
    const element = row.getElement();
    element.style.background = "rgba(0, 0, 0)";
    element.style.color = "white";
    element.style.fontWeight = "bold";
    element.style.transition = "background-color 0.3s ease";
    element.addEventListener("mouseenter", () => { element.style.background = "#000000"; });
    element.addEventListener("mouseleave", () => { element.style.background = "rgba(0, 0, 0)"; });
}

function buildGatesTable(gates) {
    new Tabulator(".gates-table", {
        // tickCross needs true/false, so turn "Open"/"Closed" into a boolean
        data: gates.map(gate => ({ ...gate, is_open: gate.gate_status === "Open" })),
        layout: "fitData",
        responsiveLayout: "collapse",
        placeholder: "No gates yet",
        columns: [
            { title: "Gate No", field: "gate_no", width: 180, hozAlign: "center", sorter: "number" },
            { title: "Status", field: "is_open", width: 192, hozAlign: "center", formatter: "tickCross", formatterParams: {
                tickElement: "<span>🟢 Open</span>",
                crossElement: "<span>🔴 Closed</span>",
            } },
            { title: "No. of Opens", field: "gate_no_opens", width: 200, hozAlign: "center" },
            { title: "No. of Closes", field: "gate_no_closes", width: 200, hozAlign: "center" },
        ],
        initialSort: [{ column: "gate_no", dir: "asc" }],
        rowFormatter,
    });
}

function buildAnimalsTable(animals) {
    new Tabulator(".animals-table", {
        data: animals.map(animal => ({ ...animal, time_stamp: new Date(animal.time_stamp).toLocaleString() })),
        layout: "fitData",
        responsiveLayout: "collapse",
        placeholder: "No animals detected yet",
        // Long lists scroll inside the table instead of stretching the page
        maxHeight: "450px",
        columns: [
            { title: "ID", field: "animal_id", width: 100, hozAlign: "center", sorter: "number" },
            { title: "Type", field: "animal_type", width: 120, hozAlign: "center" },
            { title: "Name", field: "animal_name", width: 150, hozAlign: "center" },
            { title: "Endangered", field: "is_endangered", hozAlign: "center", formatter: "tickCross", formatterParams: {
                tickElement: "<span style='color:red;'>⚠️ Yes</span>",
                crossElement: "<span style='color:green;'>✅ No</span>",
            } },
            { title: "Threat", field: "is_threat", width: 120, hozAlign: "center", formatter: "tickCross", formatterParams: {
                tickElement: "<span style='color:orange;'>⚡ Threat</span>",
                crossElement: "<span style='color:green;'>✅ Safe</span>",
            } },
            { title: "Timestamp", field: "time_stamp", width: 200, hozAlign: "center" },
        ],
        initialSort: [{ column: "animal_id", dir: "asc" }],
        rowFormatter,
    });
}

function buildStatsTable(stats) {
    new Tabulator(".stats-table", {
        data: STAT_LABELS.map(({ key, label, percent }) => ({
            label,
            value: percent ? `${stats[key] ?? 0}%` : (stats[key] ?? 0),
        })),
        layout: "fitData",
        responsiveLayout: "collapse",
        columns: [
            { title: "Stat", field: "label", hozAlign: "left", width: 320 },
            { title: "Value", field: "value", hozAlign: "center", width: 320 },
        ],
        rowFormatter,
    });
}

function buildAnimalChart(animalCounts) {
    const trace = {
        x: animalCounts.map(row => row.animal_name),
        y: animalCounts.map(row => row.animal_count),
        type: "bar",
        marker: { color: "#17BECF" },
    };

    const layout = {
        title: { text: "Animals Detected" },
        xaxis: { title: { text: "Animal" } },
        yaxis: { title: { text: "Count" } },
        bargap: 0.2,
        width: 640,
        height: 450,
    };

    Plotly.newPlot("animal-count-histo", [trace], layout);
}

async function loadStats() {
    try {
        const response = await fetch("/api/stats");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { gates, animals, stats, animal_counts: animalCounts } = await response.json();

        buildGatesTable(gates);
        buildAnimalsTable(animals);
        buildAnimalChart(animalCounts);
        buildStatsTable(stats);
    } catch (error) {
        console.error("Could not load stats:", error);
        document.querySelector(".table-histo-container").insertAdjacentHTML(
            "afterbegin",
            "<p style='color: white; margin: 60px 40px;'>Stats could not be loaded. Please refresh the page.</p>"
        );
    }
}

loadStats();
