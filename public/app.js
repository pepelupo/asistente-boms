const statusEl = document.getElementById("status");
const chatWindow = document.getElementById("chatWindow");
const chatInput = document.getElementById("chatInput");
const sendButton = document.getElementById("sendButton");
const readQuoteButton = document.getElementById("readQuoteButton");
const quoteUrl = document.getElementById("quoteUrl");
const quoteOutput = document.getElementById("quoteOutput");
const generateBomButton = document.getElementById("generateBomButton");
const showStateButton = document.getElementById("showStateButton");
const attachBomButton = document.getElementById("attachBomButton");
const bomOutput = document.getElementById("bomOutput");
const bomDataForm = document.getElementById("bomDataForm");
const bomDataStatus = document.getElementById("bomDataStatus");
const bomItemsList = document.getElementById("bomItemsList");
const bomDataPanel = document.querySelector(".bom-data-panel");
const bomDataToggle = document.getElementById("bomDataToggle");
const adminPanel = document.getElementById("adminPanel");
const adminPromptView = document.getElementById("adminPromptView");
const adminContextFile = document.getElementById("adminContextFile");
const adminFileList = document.getElementById("adminFileList");
const adminStatus = document.getElementById("adminStatus");
const userAdminPanel = document.getElementById("userAdminPanel");
const userCreateForm = document.getElementById("userCreateForm");
const userList = document.getElementById("userList");
const userAdminStatus = document.getElementById("userAdminStatus");
const refreshUsersButton = document.getElementById("refreshUsersButton");
const refreshPromptButton = document.getElementById("refreshPromptButton");
const saveAdminPromptButton = document.getElementById("saveAdminPromptButton");
const uploadAdminFileButton = document.getElementById("uploadAdminFileButton");
const workViewButton = document.getElementById("workViewButton");
const configViewButton = document.getElementById("configViewButton");
const logoutButton = document.getElementById("logoutButton");
const workPage = document.getElementById("workPage");
const configPage = document.getElementById("configPage");
const newQuoteSubject = document.getElementById("newQuoteSubject");
const accountSearch = document.getElementById("accountSearch");
const searchAccountButton = document.getElementById("searchAccountButton");
const accountResults = document.getElementById("accountResults");
const newAccountName = document.getElementById("newAccountName");
const createAccountButton = document.getElementById("createAccountButton");
const contactSearch = document.getElementById("contactSearch");
const searchContactButton = document.getElementById("searchContactButton");
const contactResults = document.getElementById("contactResults");
const newContactFirstName = document.getElementById("newContactFirstName");
const newContactLastName = document.getElementById("newContactLastName");
const newContactEmail = document.getElementById("newContactEmail");
const createContactButton = document.getElementById("createContactButton");
const productSearch = document.getElementById("productSearch");
const searchProductButton = document.getElementById("searchProductButton");
const productResults = document.getElementById("productResults");
const newQuoteQuantity = document.getElementById("newQuoteQuantity");
const newQuoteListPrice = document.getElementById("newQuoteListPrice");
const createQuoteButton = document.getElementById("createQuoteButton");
const createQuoteStatus = document.getElementById("createQuoteStatus");
let currentUserIsAdmin = false;
let currentUserCanAccessConfig = false;
let currentUserCanManageUsers = false;
const newQuoteSelection = {
  account: null,
  contact: null,
  product: null,
};

loadStatus().then(() => {
  setActivePage(window.location.hash === "#configuracion" ? "config" : "work");
});
loadBomData();
setBomDataCollapsed(localStorage.getItem("bomDataCollapsed") === "true");

sendButton.addEventListener("click", sendLocalMessage);
generateBomButton.addEventListener("click", generateBomPreview);
showStateButton.addEventListener("click", showSavedState);
attachBomButton.addEventListener("click", attachBomToZoho);
bomDataForm.addEventListener("submit", saveBomData);
bomDataToggle.addEventListener("click", toggleBomDataPanel);
refreshPromptButton.addEventListener("click", loadAdminPrompt);
saveAdminPromptButton.addEventListener("click", saveAdminPrompt);
uploadAdminFileButton.addEventListener("click", uploadAdminContextFile);
refreshUsersButton.addEventListener("click", loadUsers);
userCreateForm.addEventListener("submit", createUser);
workViewButton.addEventListener("click", () => setActivePage("work"));
configViewButton.addEventListener("click", () => setActivePage("config"));
logoutButton.addEventListener("click", logout);
searchAccountButton.addEventListener("click", () => searchAccounts());
createAccountButton.addEventListener("click", () => createAccount());
searchContactButton.addEventListener("click", () => searchContacts());
createContactButton.addEventListener("click", () => createContact());
searchProductButton.addEventListener("click", () => searchProducts());
createQuoteButton.addEventListener("click", () => createQuoteInZoho());
window.addEventListener("hashchange", () => {
  setActivePage(window.location.hash === "#configuracion" ? "config" : "work", { keepHash: true });
});
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendLocalMessage();
});

function setActivePage(page, options = {}) {
  if (page === "config" && !currentUserCanAccessConfig) page = "work";
  const showConfig = page === "config";
  workPage.classList.toggle("hidden", showConfig);
  configPage.classList.toggle("hidden", !showConfig);
  workViewButton.classList.toggle("active", !showConfig);
  configViewButton.classList.toggle("active", showConfig);

  if (!options.keepHash) {
    const nextHash = showConfig ? "#configuracion" : "#trabajo";
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  }
}

function toggleBomDataPanel() {
  const nextCollapsed = !bomDataPanel.classList.contains("collapsed");
  setBomDataCollapsed(nextCollapsed);
  localStorage.setItem("bomDataCollapsed", String(nextCollapsed));
}

function setBomDataCollapsed(collapsed) {
  bomDataPanel.classList.toggle("collapsed", collapsed);
  bomDataToggle.setAttribute("aria-expanded", String(!collapsed));
  bomDataToggle.setAttribute("aria-label", collapsed ? "Abrir datos para la BOM" : "Contraer datos para la BOM");
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
}

async function searchAccounts() {
  await searchZohoRecords({
    module: "Accounts",
    query: accountSearch.value,
    output: accountResults,
    label: "cliente",
    onSelect: (record) => {
      newQuoteSelection.account = record;
      accountSearch.value = record.name || "";
      createQuoteStatus.textContent = `Cliente seleccionado: ${record.name}`;
    },
  });
}

async function searchContacts() {
  await searchZohoRecords({
    module: "Contacts",
    query: contactSearch.value,
    output: contactResults,
    label: "contacto",
    onSelect: (record) => {
      newQuoteSelection.contact = record;
      contactSearch.value = record.name || record.email || "";
      if (record.accountId && !newQuoteSelection.account) {
        newQuoteSelection.account = {
          id: record.accountId,
          name: record.accountName,
        };
        accountSearch.value = record.accountName || "";
      }
      createQuoteStatus.textContent = `Contacto seleccionado: ${record.name || record.email}`;
    },
  });
}

async function searchProducts() {
  await searchZohoRecords({
    module: "Products",
    query: productSearch.value,
    output: productResults,
    label: "producto",
    onSelect: (record) => {
      newQuoteSelection.product = record;
      productSearch.value = record.name || "";
      if (record.unitPrice !== undefined && record.unitPrice !== null) {
        newQuoteListPrice.value = Number(record.unitPrice || 0);
      }
      createQuoteStatus.textContent = `Producto seleccionado: ${record.name}`;
    },
  });
}

async function searchZohoRecords({ module, query, output, label, onSelect }) {
  const text = String(query || "").trim();
  if (!text) {
    output.innerHTML = `<p class="muted small">Escribi algo para buscar.</p>`;
    return;
  }

  output.innerHTML = `<p class="muted small">Buscando ${escapeHtml(label)}...</p>`;

  try {
    const response = await fetch("/api/zoho/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ module, query: text }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `No pude buscar ${label}.`);

    renderFinderResults(output, data.records || [], label, onSelect);
  } catch (error) {
    output.innerHTML = `<p class="muted small">${escapeHtml(error.message)}</p>`;
  }
}

function renderFinderResults(container, records, label, onSelect) {
  if (!records.length) {
    container.innerHTML = `<p class="muted small">No encontre ${escapeHtml(label)} en Zoho.</p>`;
    return;
  }

  container.innerHTML = records
    .map((record, index) => {
      const title = record.name || record.email || record.code || record.id;
      const meta = [record.email, record.accountName, record.code, record.phone].filter(Boolean).join(" · ");
      return `<button class="finder-result" type="button" data-result-index="${index}">
        <span>${escapeHtml(title)}</span>
        <small>${escapeHtml(meta || record.id)}</small>
      </button>`;
    })
    .join("");

  for (const button of container.querySelectorAll("[data-result-index]")) {
    button.addEventListener("click", () => {
      const record = records[Number(button.dataset.resultIndex)];
      onSelect(record);
      renderSelectedResult(container, record);
    });
  }
}

function renderSelectedResult(container, record) {
  const title = record.name || record.email || record.code || record.id;
  const meta = [record.email, record.accountName, record.code, record.phone].filter(Boolean).join(" · ");
  container.innerHTML = `<div class="selected-result">
    <span>${escapeHtml(title)}</span>
    <small>${escapeHtml(meta || "Seleccionado")}</small>
  </div>`;
}

async function createAccount() {
  const accountName = newAccountName.value.trim() || accountSearch.value.trim();
  if (!accountName) {
    createQuoteStatus.textContent = "Escribi el nombre del cliente a crear.";
    return;
  }

  createAccountButton.disabled = true;
  createQuoteStatus.textContent = "Creando cliente en Zoho...";

  try {
    const response = await fetch("/api/zoho/account", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountName }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude crear el cliente.");

    newQuoteSelection.account = data.account;
    accountSearch.value = data.account && data.account.name ? data.account.name : accountName;
    newAccountName.value = "";
    renderSelectedResult(accountResults, newQuoteSelection.account || { name: accountName });
    createQuoteStatus.textContent = `Cliente creado: ${accountSearch.value}`;
  } catch (error) {
    createQuoteStatus.textContent = error.message;
  } finally {
    createAccountButton.disabled = false;
  }
}

async function createContact() {
  const firstName = newContactFirstName.value.trim();
  const lastName = newContactLastName.value.trim();
  const email = newContactEmail.value.trim() || contactSearch.value.trim();

  if (!lastName) {
    createQuoteStatus.textContent = "Para crear contacto, Zoho pide apellido.";
    return;
  }

  createContactButton.disabled = true;
  createQuoteStatus.textContent = "Creando contacto en Zoho...";

  try {
    const response = await fetch("/api/zoho/contact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        firstName,
        lastName,
        email,
        accountId: newQuoteSelection.account && newQuoteSelection.account.id,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude crear el contacto.");

    newQuoteSelection.contact = data.contact;
    contactSearch.value = data.contact && data.contact.name ? data.contact.name : [firstName, lastName].filter(Boolean).join(" ");
    newContactFirstName.value = "";
    newContactLastName.value = "";
    newContactEmail.value = "";
    renderSelectedResult(contactResults, newQuoteSelection.contact || { name: contactSearch.value, email });
    createQuoteStatus.textContent = `Contacto creado: ${contactSearch.value}`;
  } catch (error) {
    createQuoteStatus.textContent = error.message;
  } finally {
    createContactButton.disabled = false;
  }
}

async function createQuoteInZoho() {
  const subject = newQuoteSubject.value.trim();
  if (!subject) {
    createQuoteStatus.textContent = "Completa el asunto del presupuesto.";
    return;
  }
  if (!newQuoteSelection.account) {
    createQuoteStatus.textContent = "Selecciona o crea primero el cliente.";
    return;
  }
  if (!newQuoteSelection.contact) {
    createQuoteStatus.textContent = "Selecciona o crea primero el contacto.";
    return;
  }
  if (!newQuoteSelection.product) {
    createQuoteStatus.textContent = "Selecciona primero un producto.";
    return;
  }

  createQuoteButton.disabled = true;
  createQuoteButton.textContent = "Creando...";
  createQuoteStatus.textContent = "Creando presupuesto en Zoho...";

  try {
    const response = await fetch("/api/zoho/quote/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject,
        accountId: newQuoteSelection.account.id,
        contactId: newQuoteSelection.contact.id,
        productId: newQuoteSelection.product.id,
        quantity: Number(newQuoteQuantity.value || 1),
        listPrice: Number(newQuoteListPrice.value || 0),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude crear el presupuesto.");

    quoteOutput.textContent = JSON.stringify(data.quoteContext || data, null, 2);
    bomOutput.textContent = "Presupuesto creado y cargado. Completa los datos por chat y despues genera la BOM.";
    createQuoteStatus.textContent = `Presupuesto creado: ${data.quote && (data.quote.quoteNumber || data.quote.id)}`;
    addMessage("assistant", "Presupuesto creado y cargado. Arranquemos por items principales.");
    await loadBomData();
  } catch (error) {
    createQuoteStatus.textContent = error.message;
  } finally {
    createQuoteButton.disabled = false;
    createQuoteButton.textContent = "Crear presupuesto en Zoho";
  }
}

readQuoteButton.addEventListener("click", async () => {
  const value = quoteUrl.value.trim();
  if (!value) {
    addMessage("assistant", "Pega primero el link de un presupuesto de Zoho.");
    return;
  }

  addMessage("user", value);
  addMessage("assistant", "Voy a leer ese presupuesto en Zoho.");
  quoteOutput.textContent = "Leyendo presupuesto...";

  try {
    const response = await fetch("/api/zoho/quote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ quoteUrl: value }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "No se pudo leer el presupuesto.");
    }

    quoteOutput.textContent = JSON.stringify(data, null, 2);
    bomOutput.textContent = "Presupuesto leido. Completa los datos por chat y despues genera la BOM.";
    addMessage("assistant", "Listo, pude leer el presupuesto. Revisa los datos detectados abajo.");
    await loadBomData();

    addMessage("assistant", firstBomQuestion(data));
  } catch (error) {
    quoteOutput.textContent = error.message;
    addMessage("assistant", error.message);
  }
});

async function loadStatus() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();

    statusEl.innerHTML = "";
    addStatus("Zoho Client ID", config.zoho.hasClientId);
    addStatus("Zoho Client Secret", config.zoho.hasClientSecret);
    addStatus("OpenAI API Key", config.openai.hasApiKey);
    addInfo("Modelo OpenAI", config.openai.model || "no definido");
    addInfo("Redirect URI", config.zoho.redirectUri);
    addInfo("Scopes Zoho", config.zoho.scopes);
    if (config.currentUser) {
      currentUserIsAdmin = Boolean(config.currentUser.isAdmin);
      currentUserCanAccessConfig = Boolean(config.currentUser.canAccessConfig);
      currentUserCanManageUsers = Boolean(config.currentUser.canManageUsers);
      configViewButton.classList.toggle("hidden", !currentUserCanAccessConfig);
      adminPanel.classList.toggle("hidden", !currentUserIsAdmin);
      userAdminPanel.classList.toggle("hidden", !currentUserCanManageUsers);
      addInfo("Usuario", `${config.currentUser.username} - ${config.currentUser.roleLabel || config.currentUser.role || "comercial"}`);

      if (currentUserIsAdmin) await loadAdminPrompt();
      if (currentUserCanManageUsers) await loadUsers();
      if (!currentUserCanAccessConfig) setActivePage("work");
    }
  } catch (error) {
    statusEl.innerHTML = `<p class="muted">No pude leer el estado del servidor.</p>`;
  }
}

function addStatus(label, ok) {
  const row = document.createElement("div");
  row.className = "status-row";
  row.innerHTML = `<span>${escapeHtml(label)}</span><span class="badge ${ok ? "ok" : "missing"}">${
    ok ? "configurado" : "pendiente"
  }</span>`;
  statusEl.appendChild(row);
}

function addInfo(label, value) {
  const row = document.createElement("div");
  row.className = "status-row";
  row.innerHTML = `<span>${escapeHtml(label)}</span><span class="muted">${escapeHtml(value)}</span>`;
  statusEl.appendChild(row);
}

async function sendLocalMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  addMessage("user", text);
  sendButton.disabled = true;
  sendButton.textContent = "Pensando...";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: text }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "No pude consultar al agente.");
    }

    addMessage("assistant", data.answer);
    await loadBomData();
  } catch (error) {
    addMessage("assistant", error.message);
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = "Enviar";
  }
}

async function generateBomPreview() {
  generateBomButton.disabled = true;
  generateBomButton.textContent = "Generando...";
  bomOutput.textContent = "Armando BOM...";

  try {
    const response = await fetch("/api/bom/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "No pude generar la BOM.");
    }

    bomOutput.textContent = data.text || JSON.stringify(data, null, 2);
    addMessage("assistant", "Ya prepare una vista previa de la BOM con el formato del ejemplo.");
  } catch (error) {
    bomOutput.textContent = error.message;
    addMessage("assistant", error.message);
  } finally {
    generateBomButton.disabled = false;
    generateBomButton.textContent = "Generar BOM";
  }
}

async function showSavedState() {
  showStateButton.disabled = true;
  showStateButton.textContent = "Leyendo...";

  try {
    const data = await loadBomData();

    bomOutput.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    bomOutput.textContent = error.message;
  } finally {
    showStateButton.disabled = false;
    showStateButton.textContent = "Ver datos guardados";
  }
}

async function attachBomToZoho() {
  attachBomButton.disabled = true;
  attachBomButton.textContent = "Subiendo...";
  bomOutput.textContent = "Generando y subiendo BOM a Zoho...";

  try {
    const response = await fetch("/api/zoho/quote/attach-bom", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "No pude subir la BOM a Zoho.");
    }

    bomOutput.textContent = JSON.stringify(data, null, 2);
    addMessage("assistant", `BOM subida a Zoho como adjunto: ${data.filename}`);
  } catch (error) {
    bomOutput.textContent = error.message;
    addMessage("assistant", error.message);
  } finally {
    attachBomButton.disabled = false;
    attachBomButton.textContent = "Subir BOM a Zoho";
  }
}

async function loadBomData() {
  const response = await fetch("/api/bom/state");
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "No pude leer los datos guardados.");
  }

  fillBomDataForm(data.bomState || {});
  const stage = data.conversationProgress && data.conversationProgress.currentStage;
  bomDataStatus.textContent = stage ? `Etapa actual: ${stage}` : "Datos cargados.";
  return data;
}

async function saveBomData(event) {
  event.preventDefault();
  const payload = { bomState: collectBomDataForm() };

  bomDataStatus.textContent = "Guardando cambios...";
  try {
    const response = await fetch("/api/bom/state", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "No pude guardar los cambios.");
    }

    fillBomDataForm(data.bomState || {});
    const stage = data.conversationProgress && data.conversationProgress.currentStage;
    bomDataStatus.textContent = stage ? `Cambios guardados. Etapa: ${stage}` : "Cambios guardados.";
  } catch (error) {
    bomDataStatus.textContent = error.message;
  }
}

function fillBomDataForm(state) {
  renderBomItems(state.items || {});
  for (const field of getBomDataFields()) {
    const value = getPathValue(state, field.dataset.field);
    if (field.tagName === "SELECT") {
      field.value = value === true ? "true" : value === false ? "false" : value || "";
    } else {
      field.value = value === null || value === undefined ? "" : value;
    }
  }
}

function collectBomDataForm() {
  const state = {};
  for (const field of getBomDataFields()) {
    setPathValue(state, field.dataset.field, readFieldValue(field));
  }
  state.items = state.items || {};
  state.items.quoteLines = collectBomItemLines();
  return state;
}

function getBomDataFields() {
  return Array.from(bomDataForm.querySelectorAll("[data-field]"));
}

function renderBomItems(items) {
  const lines = Array.isArray(items.quoteLines) && items.quoteLines.length
    ? items.quoteLines
    : [
        {
          productName: items.productName || "",
          description: items.observations || "",
          quantity: items.quantity,
          costUnitUsd: items.costUnitUsd,
          provider: items.provider || "",
          paymentCondition: items.paymentCondition || "",
        },
      ];

  bomItemsList.innerHTML = "";
  lines.forEach((line, index) => {
    const card = document.createElement("section");
    card.className = "bom-item-card";
    card.innerHTML = `
      <h4>Item ${index + 1}</h4>
      <label for="bomItemProduct${index}">Producto</label>
      <input id="bomItemProduct${index}" data-item-index="${index}" data-item-prop="productName" type="text" />
      <label for="bomItemDescription${index}">Descripcion</label>
      <textarea id="bomItemDescription${index}" data-item-index="${index}" data-item-prop="description" rows="3"></textarea>
      <div class="form-grid">
        <div class="field-block">
          <label for="bomItemQuantity${index}">Cantidad</label>
          <input id="bomItemQuantity${index}" data-item-index="${index}" data-item-prop="quantity" type="number" step="any" />
        </div>
        <div class="field-block">
          <label for="bomItemCost${index}">Costo unit. USD</label>
          <input id="bomItemCost${index}" data-item-index="${index}" data-item-prop="costUnitUsd" type="number" step="any" />
        </div>
      </div>
      <label for="bomItemProvider${index}">Proveedor</label>
      <input id="bomItemProvider${index}" data-item-index="${index}" data-item-prop="provider" type="text" />
      <label for="bomItemPayment${index}">Condicion de pago</label>
      <input id="bomItemPayment${index}" data-item-index="${index}" data-item-prop="paymentCondition" type="text" />
    `;
    bomItemsList.appendChild(card);

    for (const field of card.querySelectorAll("[data-item-prop]")) {
      const value = line[field.dataset.itemProp];
      field.value = value === null || value === undefined ? "" : value;
    }
  });
}

function collectBomItemLines() {
  const lines = [];
  for (const field of bomItemsList.querySelectorAll("[data-item-index][data-item-prop]")) {
    const index = Number(field.dataset.itemIndex);
    const prop = field.dataset.itemProp;
    if (!lines[index]) lines[index] = {};
    lines[index][prop] = readFieldValue(field);
  }
  return lines.filter(Boolean);
}

function readFieldValue(field) {
  if (field.tagName === "SELECT") {
    if (field.value === "true") return true;
    if (field.value === "false") return false;
    return field.value || null;
  }

  if (field.type === "number") {
    return field.value === "" ? null : Number(field.value);
  }

  return field.value;
}

function getPathValue(object, path) {
  return path.split(".").reduce((value, key) => (value && value[key] !== undefined ? value[key] : undefined), object);
}

function setPathValue(object, path, value) {
  const parts = path.split(".");
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part]) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

async function loadAdminPrompt() {
  if (!currentUserIsAdmin) return;
  adminStatus.textContent = "Leyendo prompt...";

  try {
    const response = await fetch("/api/admin/prompt");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude leer el prompt.");

    adminPromptView.value = data.effectivePrompt || "";
    renderAdminFiles(data.files || []);
    adminStatus.textContent = "Prompt actualizado.";
  } catch (error) {
    adminStatus.textContent = error.message;
  }
}

async function loadUsers() {
  if (!currentUserCanManageUsers) return;
  userAdminStatus.textContent = "Leyendo usuarios...";

  try {
    const response = await fetch("/api/admin/users");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude leer usuarios.");

    renderUsers(data.users || []);
    userAdminStatus.textContent = "Usuarios actualizados.";
  } catch (error) {
    userAdminStatus.textContent = error.message;
  }
}

async function createUser(event) {
  event.preventDefault();
  if (!currentUserCanManageUsers) return;

  const form = new FormData(userCreateForm);
  const payload = {
    name: form.get("name"),
    email: form.get("email"),
    username: form.get("username"),
    password: form.get("password"),
    role: form.get("role"),
  };

  userAdminStatus.textContent = "Creando usuario...";

  try {
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude crear el usuario.");

    userCreateForm.reset();
    renderUsers(data.users || []);
    userAdminStatus.textContent = "Usuario creado.";
  } catch (error) {
    userAdminStatus.textContent = error.message;
  }
}

function renderUsers(users) {
  if (!users.length) {
    userList.innerHTML = `<p class="muted small">Todavia no hay usuarios.</p>`;
    return;
  }

  userList.innerHTML = users
    .map(
      (user) => `<section class="user-row">
        <div>
          <strong>${escapeHtml(user.name || user.username)}</strong>
          <span>${escapeHtml(user.email || user.username)}</span>
        </div>
        <div>
          <span class="role-pill">${escapeHtml(user.roleLabel || user.role)}</span>
        </div>
        <div class="user-actions">
          <button class="button compact secondary" type="button" data-reset-user="${escapeHtml(user.username)}">Resetear contraseña</button>
          <button class="button compact danger" type="button" data-delete-user="${escapeHtml(user.username)}">Eliminar</button>
        </div>
      </section>`
    )
    .join("");

  for (const button of userList.querySelectorAll("[data-reset-user]")) {
    button.addEventListener("click", () => resetUserPassword(button.dataset.resetUser));
  }

  for (const button of userList.querySelectorAll("[data-delete-user]")) {
    button.addEventListener("click", () => deleteUser(button.dataset.deleteUser));
  }
}

async function resetUserPassword(username) {
  const password = window.prompt(`Nueva contraseña para ${username}`);
  if (!password) return;

  userAdminStatus.textContent = "Reseteando contraseña...";

  try {
    const response = await fetch("/api/admin/users/reset-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude resetear la contraseña.");

    renderUsers(data.users || []);
    userAdminStatus.textContent = "Contraseña reseteada.";
  } catch (error) {
    userAdminStatus.textContent = error.message;
  }
}

async function deleteUser(username) {
  if (!window.confirm(`Eliminar el usuario ${username}?`)) return;

  userAdminStatus.textContent = "Eliminando usuario...";

  try {
    const response = await fetch("/api/admin/users/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude eliminar el usuario.");

    renderUsers(data.users || []);
    userAdminStatus.textContent = "Usuario eliminado.";
  } catch (error) {
    userAdminStatus.textContent = error.message;
  }
}

async function saveAdminPrompt() {
  adminStatus.textContent = "Guardando prompt...";

  try {
    const response = await fetch("/api/admin/prompt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: adminPromptView.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude guardar el prompt.");

    adminPromptView.value = data.effectivePrompt || "";
    renderAdminFiles(data.files || []);
    adminStatus.textContent = "Prompt guardado.";
  } catch (error) {
    adminStatus.textContent = error.message;
  }
}

async function uploadAdminContextFile() {
  const file = adminContextFile.files && adminContextFile.files[0];
  if (!file) {
    adminStatus.textContent = "Selecciona primero un archivo.";
    return;
  }

  adminStatus.textContent = "Subiendo archivo...";

  try {
    const payload = await buildAdminFilePayload(file);
    const response = await fetch("/api/admin/files", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude subir el archivo.");

    adminContextFile.value = "";
    adminPromptView.value = data.effectivePrompt || "";
    renderAdminFiles(data.files || []);
    adminStatus.textContent = "Archivo agregado al prompt.";
  } catch (error) {
    adminStatus.textContent = error.message;
  }
}

function buildAdminFilePayload(file) {
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "docx") {
    return readFileAsDataUrl(file).then((dataUrl) => ({
      fileName: file.name,
      contentBase64: dataUrl.split(",")[1] || "",
    }));
  }

  return readFileAsText(file).then((content) => ({
    fileName: file.name,
    content,
  }));
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No pude leer el archivo."));
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No pude leer el archivo."));
    reader.readAsDataURL(file);
  });
}

function renderAdminFiles(files) {
  if (!files.length) {
    adminFileList.innerHTML = `<p class="muted small">Todavia no hay archivos de contexto.</p>`;
    return;
  }

  adminFileList.innerHTML = files
    .map(
      (file) => `<div class="admin-file">
        <div>
          <span>${escapeHtml(file.name)}</span>
          <small>${escapeHtml(file.size)} caracteres</small>
        </div>
        <button class="button danger compact" type="button" data-delete-admin-file="${escapeHtml(file.name)}">Eliminar</button>
      </div>`
    )
    .join("");

  for (const button of adminFileList.querySelectorAll("[data-delete-admin-file]")) {
    button.addEventListener("click", () => deleteAdminContextFile(button.dataset.deleteAdminFile));
  }
}

async function deleteAdminContextFile(name) {
  adminStatus.textContent = "Eliminando archivo...";

  try {
    const response = await fetch("/api/admin/files/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude eliminar el archivo.");

    adminPromptView.value = data.effectivePrompt || "";
    renderAdminFiles(data.files || []);
    adminStatus.textContent = "Archivo eliminado.";
  } catch (error) {
    adminStatus.textContent = error.message;
  }
}

function addMessage(role, text) {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  message.textContent = text;
  chatWindow.appendChild(message);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function firstBomQuestion(data) {
  const quote = data.quote || {};
  const items = quote.productDetails || [];
  const firstItem = items[0];

  if (items.length) {
    const summary = items
      .slice(0, 4)
      .map((item) => `${item.quantity || 1} x ${item.productName || "item"} a USD ${item.listPrice || 0}`)
      .join("; ");
    const more = items.length > 4 ? ` y ${items.length - 4} mas` : "";
    return `Arranquemos por items principales. Zoho trajo ${items.length} item(s): ${summary}${more}. Pasame solo costo unitario USD de cada item y margen divisor general.`;
  }

  return "Arranquemos por items principales. Pasame solo costo unitario USD y margen divisor general.";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
