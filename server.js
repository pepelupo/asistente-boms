const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const envPath = path.join(rootDir, ".env");

loadEnv(envPath);
const dataDir = process.env.DATA_DIR ? path.resolve(rootDir, process.env.DATA_DIR) : rootDir;
const usersPath = path.join(dataDir, "usuarios.json");
const tokenPath = path.join(dataDir, ".zoho-token.json");
const bomDataPath = path.join(dataDir, "bom-datos-actuales.json");
const adminContextDir = path.join(dataDir, "admin-context");
const adminFilesDir = path.join(adminContextDir, "files");
const adminPromptPath = path.join(adminContextDir, "prompt-actual.txt");

const PORT = Number(process.env.PORT || 3000);
const ZOHO_ACCOUNTS_BASE = process.env.ZOHO_ACCOUNTS_BASE || "https://accounts.zoho.com";
const ZOHO_CRM_BASE = process.env.ZOHO_CRM_BASE || "https://www.zohoapis.com/crm/v8";
const ZOHO_REDIRECT_URI =
  process.env.ZOHO_REDIRECT_URI || `http://localhost:${PORT}/api/auth/zoho/callback`;
const ZOHO_SCOPES = process.env.ZOHO_SCOPES || "ZohoCRM.modules.ALL,ZohoCRM.settings.READ";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const CURRENT_USER = process.env.CURRENT_USER || "ignacio.vidalbruni";
const ADMIN_USERS = splitList(process.env.ADMIN_USERS || "ignacio.vidalbruni,ignacio.vidalbruni@bessel.com.ar");

const states = new Set();
const sessions = new Map();
const authSessions = new Map();
const chatHistory = [];
let dbPool = null;
let storageMode = "files";
let users = [];
let adminPromptCache = "";
let adminFilesCache = [];
let bomState = createEmptyBomState();
let lastAgentStage = "";
let lastQuoteContext = null;
let savedZohoToken = null;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/api/health") {
      return sendJson(res, {
        ok: true,
        appName: "Asistente para BOMs",
        time: new Date().toISOString(),
      });
    }

    if (url.pathname.startsWith("/api/zia/")) {
      return handleZiaToolRequest(req, res, url);
    }

    if (url.pathname === "/login") {
      const currentUser = getAuthenticatedUser(req);
      if (currentUser) {
        res.writeHead(302, { Location: "/" });
        return res.end();
      }
      return serveStatic(req, res, "/login.html");
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      const user = verifyLogin(body.username, body.password);
      if (!user) return sendError(res, 401, "Usuario o contraseña incorrectos.");

      const sessionId = createAuthSession(user);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": authCookie(sessionId),
      });
      return res.end(JSON.stringify({ ok: true, user: publicUser(user) }, null, 2));
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      const sessionId = readCookie(req, "bom_session");
      if (sessionId) authSessions.delete(sessionId);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": clearAuthCookie(),
      });
      return res.end(JSON.stringify({ ok: true }, null, 2));
    }

    if (isPublicAssetPath(url.pathname)) {
      return serveStatic(req, res, url.pathname);
    }

    const currentUser = getAuthenticatedUser(req);
    if (!currentUser) {
      if (url.pathname.startsWith("/api/")) return sendError(res, 401, "Tenes que iniciar sesion.");
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }

    if (url.pathname === "/api/config") {
      return sendJson(res, {
        appName: "Asistente para BOMs",
        zoho: {
          hasClientId: Boolean(process.env.ZOHO_CLIENT_ID),
          hasClientSecret: Boolean(process.env.ZOHO_CLIENT_SECRET),
          redirectUri: ZOHO_REDIRECT_URI,
          accountsBase: ZOHO_ACCOUNTS_BASE,
          crmBase: ZOHO_CRM_BASE,
          scopes: ZOHO_SCOPES,
        },
        openai: {
          hasApiKey: isConfiguredSecret(process.env.OPENAI_API_KEY, ["pegar_openai_api_key"]),
          model: OPENAI_MODEL,
        },
        storage: {
          dataDir,
        },
        currentUser: {
          username: currentUser.username,
          name: currentUser.name || "",
          email: currentUser.email || "",
          role: currentUser.role || "comercial",
          isAdmin: isAdminUser(currentUser),
        },
      });
    }

    if (url.pathname === "/api/auth/zoho/start") {
      if (!process.env.ZOHO_CLIENT_ID) {
        return sendError(res, 400, "Falta configurar ZOHO_CLIENT_ID en el archivo .env.");
      }

      const state = crypto.randomBytes(16).toString("hex");
      states.add(state);

      const authUrl = new URL("/oauth/v2/auth", ZOHO_ACCOUNTS_BASE);
      authUrl.searchParams.set("scope", ZOHO_SCOPES);
      authUrl.searchParams.set("client_id", process.env.ZOHO_CLIENT_ID);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("redirect_uri", ZOHO_REDIRECT_URI);
      authUrl.searchParams.set("state", state);

      res.writeHead(302, { Location: authUrl.toString() });
      return res.end();
    }

    if (url.pathname === "/api/auth/zoho/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return sendHtml(res, callbackPage("Zoho rechazo la conexion", error));
      }

      if (!code || !state || !states.has(state)) {
        return sendHtml(res, callbackPage("No se pudo validar la conexion", "Falta el codigo o el estado no coincide."));
      }

      states.delete(state);

      if (!process.env.ZOHO_CLIENT_SECRET || !process.env.ZOHO_CLIENT_ID) {
        return sendHtml(
          res,
          callbackPage(
            "Zoho devolvio el permiso, pero faltan credenciales",
            "Configura ZOHO_CLIENT_ID y ZOHO_CLIENT_SECRET en .env para poder terminar la conexion."
          )
        );
      }

      const tokenResponse = await exchangeZohoCode(code);
      savedZohoToken = mergeToken(savedZohoToken, tokenResponse);
      saveZohoToken(tokenPath, savedZohoToken);

      const userKey = crypto.randomBytes(12).toString("hex");
      sessions.set(userKey, {
        createdAt: new Date().toISOString(),
        token: tokenResponse,
      });

      return sendHtml(
        res,
        callbackPage(
          "Conexion con Zoho lista",
          "El prototipo pudo recibir y canjear el permiso de Zoho. En el siguiente paso lo usaremos para leer presupuestos.",
          userKey
        )
      );
    }

    if (url.pathname === "/api/zoho/status") {
      return sendJson(res, {
        connectedSessions: sessions.size,
        hasSavedConnection: Boolean(savedZohoToken && savedZohoToken.refresh_token),
        note:
          savedZohoToken && savedZohoToken.refresh_token
            ? "Hay una conexion Zoho guardada localmente."
            : "Todavia no hay usuarios conectados a Zoho.",
      });
    }

    if (url.pathname === "/api/bom/state" && req.method === "GET") {
      return sendJson(res, {
        bomState: buildEditableBomState(),
        conversationProgress: analyzeConversationProgress(),
      });
    }

    if (url.pathname === "/api/bom/state" && req.method === "POST") {
      const body = await readJsonBody(req);
      applyManualBomState(body.bomState || {});
      saveBomDataSnapshot();
      return sendJson(res, {
        bomState: buildEditableBomState(),
        conversationProgress: analyzeConversationProgress(),
      });
    }

    if (url.pathname === "/api/bom/download") {
      saveBomDataSnapshot();
      return sendDownloadJson(res, "datos-para-bom.json", buildBomDataFile());
    }

    if (url.pathname === "/api/admin/prompt" && req.method === "GET") {
      if (!isAdminUser(currentUser)) return sendError(res, 403, "Esta seccion es solo para administradores.");
      return sendJson(res, buildAdminPromptResponse(currentUser));
    }

    if (url.pathname === "/api/admin/prompt" && req.method === "POST") {
      if (!isAdminUser(currentUser)) return sendError(res, 403, "Esta seccion es solo para administradores.");
      const body = await readJsonBody(req);
      saveAdminPrompt(String(body.prompt || ""));
      return sendJson(res, buildAdminPromptResponse(currentUser));
    }

    if (url.pathname === "/api/admin/files" && req.method === "POST") {
      if (!isAdminUser(currentUser)) return sendError(res, 403, "Esta seccion es solo para administradores.");
      const body = await readJsonBody(req);
      saveAdminContextFile(body);
      return sendJson(res, buildAdminPromptResponse(currentUser));
    }

    if (url.pathname === "/api/admin/files/delete" && req.method === "POST") {
      if (!isAdminUser(currentUser)) return sendError(res, 403, "Esta seccion es solo para administradores.");
      const body = await readJsonBody(req);
      deleteAdminContextFile(String(body.name || ""));
      return sendJson(res, buildAdminPromptResponse(currentUser));
    }

    if (url.pathname === "/api/zoho/quote" && req.method === "POST") {
      const body = await readJsonBody(req);
      const quoteId = extractQuoteId(body.quoteUrl || body.quoteId || "");

      if (!quoteId) {
        return sendError(res, 400, "No pude detectar el ID del presupuesto de Zoho.");
      }

      const token = await getZohoAccessToken();
      const quote = await zohoGet(`/Quotes/${quoteId}`, token.access_token);
      const record = quote && quote.data && quote.data[0] ? quote.data[0] : null;

      if (!record) {
        return sendError(res, 404, "Zoho no devolvio datos para ese presupuesto.");
      }

      const summary = summarizeQuote(record);
      bomState = createEmptyBomState(summary);
      lastAgentStage = "";
      chatHistory.splice(0, chatHistory.length);
      lastQuoteContext = {
        quote: summary,
        bomAnalysis: analyzeBom(summary),
      };
      saveBomDataSnapshot();

      return sendJson(res, lastQuoteContext);
    }

    if (url.pathname === "/api/zoho/search" && req.method === "POST") {
      if (!isAdminUser(currentUser)) return sendError(res, 403, "Esta accion es solo para administradores.");
      const body = await readJsonBody(req);
      const moduleName = String(body.module || "").trim();
      const query = String(body.query || "").trim();

      if (!["Accounts", "Contacts", "Products"].includes(moduleName)) {
        return sendError(res, 400, "Modulo Zoho no permitido para busqueda.");
      }

      if (!query) {
        return sendError(res, 400, "Escribe un texto para buscar.");
      }

      const token = await getZohoAccessToken();
      const result = await zohoSearchRecords(moduleName, query, token.access_token);
      return sendJson(res, {
        module: moduleName,
        query,
        records: summarizeZohoRecords(moduleName, result.data || []),
      });
    }

    if (url.pathname === "/api/zoho/account" && req.method === "POST") {
      if (!isAdminUser(currentUser)) return sendError(res, 403, "Esta accion es solo para administradores.");
      const body = await readJsonBody(req);
      const accountName = String(body.accountName || "").trim();

      if (!accountName) {
        return sendError(res, 400, "Falta el nombre de la cuenta/cliente.");
      }

      const token = await getZohoAccessToken();
      const created = await zohoCreateRecord(
        "Accounts",
        {
          Account_Name: accountName,
          Phone: optionalString(body.phone),
          Website: optionalString(body.website),
        },
        token.access_token
      );
      assertZohoCreateSuccess(created);
      const accountId = extractCreatedRecordId(created);
      const record = accountId ? await zohoGet(`/Accounts/${accountId}`, token.access_token) : null;

      return sendJson(res, {
        created,
        account: record && record.data && record.data[0] ? summarizeAccount(record.data[0]) : null,
      });
    }

    if (url.pathname === "/api/zoho/contact" && req.method === "POST") {
      if (!isAdminUser(currentUser)) return sendError(res, 403, "Esta accion es solo para administradores.");
      const body = await readJsonBody(req);
      const firstName = String(body.firstName || "").trim();
      const lastName = String(body.lastName || "").trim();

      if (!lastName) {
        return sendError(res, 400, "Falta el apellido del contacto. En Zoho es obligatorio.");
      }

      const token = await getZohoAccessToken();
      const created = await zohoCreateRecord(
        "Contacts",
        {
          First_Name: firstName,
          Last_Name: lastName,
          Email: optionalString(body.email),
          Phone: optionalString(body.phone),
          Account_Name: body.accountId ? { id: String(body.accountId) } : undefined,
        },
        token.access_token
      );
      assertZohoCreateSuccess(created);
      const contactId = extractCreatedRecordId(created);
      const record = contactId ? await zohoGet(`/Contacts/${contactId}`, token.access_token) : null;

      return sendJson(res, {
        created,
        contact: record && record.data && record.data[0] ? summarizeContact(record.data[0]) : null,
      });
    }

    if (url.pathname === "/api/zoho/quote/create" && req.method === "POST") {
      if (!isAdminUser(currentUser)) return sendError(res, 403, "Esta accion es solo para administradores.");
      const body = await readJsonBody(req);
      const subject = String(body.subject || "").trim();
      const accountId = String(body.accountId || "").trim();
      const contactId = String(body.contactId || "").trim();
      const productId = String(body.productId || "").trim();
      const quantity = numberOrNull(body.quantity) || 1;
      const listPrice = numberOrNull(body.listPrice) || 0;

      if (!subject) return sendError(res, 400, "Falta el asunto del presupuesto.");
      if (!accountId) return sendError(res, 400, "Falta seleccionar cuenta/cliente.");
      if (!contactId) return sendError(res, 400, "Falta seleccionar contacto.");
      if (!productId) return sendError(res, 400, "Falta seleccionar producto.");

      const token = await getZohoAccessToken();
      const quoteFields = {
        Subject: subject,
        Account_Name: { id: accountId },
        Contact_Name: { id: contactId },
        Quote_Stage: optionalString(body.stage) || "1- Bosquejo",
        Currency: optionalString(body.currency) || "USD",
        Valid_Till: optionalString(body.validTill) || tomorrowIso(30),
        Product_Details: [
          {
            product: { id: productId },
            quantity,
            list_price: listPrice,
          },
        ],
      };
      const created = await zohoCreateRecord("Quotes", quoteFields, token.access_token);
      assertZohoCreateSuccess(created);
      const quoteId = extractCreatedRecordId(created);

      if (!quoteId) {
        return sendJson(res, {
          created,
          quote: null,
          note: "Zoho respondio, pero no pude detectar el ID del presupuesto creado.",
        });
      }

      const quote = await zohoGet(`/Quotes/${quoteId}`, token.access_token);
      const record = quote && quote.data && quote.data[0] ? quote.data[0] : null;
      const summary = record ? summarizeQuote(record) : { id: quoteId, subject };
      bomState = createEmptyBomState(summary);
      lastAgentStage = "";
      chatHistory.splice(0, chatHistory.length);
      lastQuoteContext = {
        quote: summary,
        bomAnalysis: analyzeBom(summary),
      };
      saveBomDataSnapshot();

      return sendJson(res, {
        created,
        quote: summary,
        quoteContext: lastQuoteContext,
      });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readJsonBody(req);
      const message = String(body.message || "").trim();

      if (!message) {
        return sendError(res, 400, "Escribe un mensaje para el agente.");
      }

      const answer = await askOpenAiAgent(message);
      saveBomDataSnapshot();
      return sendJson(res, {
        answer,
        model: OPENAI_MODEL,
      });
    }

    if (url.pathname === "/api/bom/preview" && req.method === "POST") {
      if (!lastQuoteContext) {
        return sendError(res, 400, "Primero lee un presupuesto de Zoho.");
      }

      return sendJson(res, await buildBomPreview());
    }

    if (url.pathname === "/api/bom/xlsx") {
      if (!lastQuoteContext) {
        return sendError(res, 400, "Primero lee un presupuesto de Zoho.");
      }

      const preview = await buildBomPreview();
      const filename = `${safeFileName(preview.title || "BOM")}.xlsx`;
      return sendDownloadBuffer(res, filename, buildXlsxFile(preview.tabs), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }

    if (url.pathname === "/api/zoho/quote/attach-bom" && req.method === "POST") {
      if (!lastQuoteContext || !lastQuoteContext.quote || !lastQuoteContext.quote.id) {
        return sendError(res, 400, "Primero lee un presupuesto de Zoho.");
      }

      const token = await getZohoAccessToken();
      const preview = await buildBomPreview();
      const filename = `${safeFileName(preview.title || "BOM")}.xlsx`;
      const fileBuffer = buildXlsxFile(preview.tabs);
      const upload = await zohoUploadAttachment("Quotes", lastQuoteContext.quote.id, filename, fileBuffer, token.access_token);
      const update = await zohoUpdateRecord("Quotes", lastQuoteContext.quote.id, { Costos: "adjunto" }, token.access_token);
      const reread = await zohoGet(`/Quotes/${lastQuoteContext.quote.id}`, token.access_token);
      const confirmedRecord = reread && reread.data && reread.data[0] ? reread.data[0] : null;
      const confirmedCosts = confirmedRecord ? confirmedRecord.Costos || "" : "";
      if (confirmedRecord) {
        lastQuoteContext.quote = summarizeQuote(confirmedRecord);
        saveBomDataSnapshot();
      }

      return sendJson(res, {
        quoteId: lastQuoteContext.quote.id,
        filename,
        upload,
        update,
        confirmedCosts,
        costsUpdated: confirmedCosts === "adjunto",
      });
    }

    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    return sendError(res, 500, error.message || "Error inesperado.");
  }
});

initializeStorage()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Asistente para BOMs abierto en http://localhost:${PORT}`);
      console.log(`Persistencia: ${storageMode}`);
    });
  })
  .catch((error) => {
    console.error("No pude inicializar la persistencia:", error);
    process.exit(1);
  });

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function isConfiguredSecret(value, placeholders) {
  if (!value) return false;
  return !placeholders.includes(String(value).trim());
}

async function initializeStorage() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await createDatabaseSchema();
    users = await loadUsersFromDatabase();
    if (!users.length) {
      users = createInitialUsers();
      for (const user of users) {
        await saveUserToDatabase(user);
      }
      console.log(`Usuarios iniciales creados en Neon: ${users.map((user) => user.username).join(", ")}`);
    }
    savedZohoToken = await dbGetJson("zoho_token");
    adminPromptCache = ((await dbGetJson("admin_prompt")) || {}).prompt || "";
    adminFilesCache = await loadAdminFilesFromDatabase();
    storageMode = "neon-postgres";
    return;
  }

  ensureDir(dataDir);
  ensureDir(adminFilesDir);
  users = loadUsers(usersPath);
  savedZohoToken = loadSavedZohoToken(tokenPath);
  storageMode = "archivos-locales";
}

async function createDatabaseSchema() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_users (
      username TEXT PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      role TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_iterations INTEGER NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_files (
      name TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function dbGetJson(key) {
  const result = await dbPool.query("SELECT value FROM app_kv WHERE key = $1", [key]);
  return result.rows[0] ? result.rows[0].value : null;
}

function dbSetJson(key, value) {
  if (!dbPool) return;
  dbPool
    .query(
      `INSERT INTO app_kv (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    )
    .catch((error) => console.error(`No pude guardar ${key} en Neon:`, error.message));
}

async function loadUsersFromDatabase() {
  const result = await dbPool.query(
    `SELECT username, name, email, role, password_salt, password_iterations, password_hash, created_at
     FROM app_users
     ORDER BY created_at ASC`
  );
  return result.rows.map((row) => ({
    username: row.username,
    name: row.name || "",
    email: row.email || "",
    role: row.role || "comercial",
    passwordSalt: row.password_salt,
    passwordIterations: row.password_iterations,
    passwordHash: row.password_hash,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : "",
  }));
}

async function saveUserToDatabase(user) {
  await dbPool.query(
    `INSERT INTO app_users (username, name, email, role, password_salt, password_iterations, password_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()))
     ON CONFLICT (username)
     DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       role = EXCLUDED.role,
       password_salt = EXCLUDED.password_salt,
       password_iterations = EXCLUDED.password_iterations,
       password_hash = EXCLUDED.password_hash`,
    [
      user.username,
      user.name || "",
      user.email || null,
      user.role || "comercial",
      user.passwordSalt,
      user.passwordIterations || 310000,
      user.passwordHash,
      user.createdAt || null,
    ]
  );
}

async function loadAdminFilesFromDatabase() {
  const result = await dbPool.query("SELECT name, content FROM admin_files ORDER BY created_at ASC");
  return result.rows
    .map((row) => ({
      name: row.name,
      content: String(row.content || "").trim().slice(0, 12000),
    }))
    .filter((file) => file.content);
}

function exchangeZohoCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    redirect_uri: ZOHO_REDIRECT_URI,
    code,
  }).toString();

  const tokenUrl = new URL("/oauth/v2/token", ZOHO_ACCOUNTS_BASE);

  return requestJson(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
}

function refreshZohoToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: refreshToken,
  }).toString();

  const tokenUrl = new URL("/oauth/v2/token", ZOHO_ACCOUNTS_BASE);

  return requestJson(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
}

async function getZohoAccessToken() {
  if (!savedZohoToken || !savedZohoToken.refresh_token) {
    throw new Error("Primero conecta Zoho desde el boton Conectar Zoho.");
  }

  const now = Date.now();
  if (savedZohoToken.access_token && savedZohoToken.expires_at && savedZohoToken.expires_at > now + 60000) {
    return savedZohoToken;
  }

  const refreshed = await refreshZohoToken(savedZohoToken.refresh_token);
  savedZohoToken = mergeToken(savedZohoToken, refreshed);
  saveZohoToken(tokenPath, savedZohoToken);
  return savedZohoToken;
}

function zohoGet(apiPath, accessToken) {
  const base = `${ZOHO_CRM_BASE.replace(/\/$/, "")}/`;
  const apiUrl = new URL(apiPath.replace(/^\//, ""), base);
  return requestJson(apiUrl, {
    method: "GET",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });
}

function zohoUploadAttachment(moduleName, recordId, filename, fileBuffer, accessToken) {
  const multipart = buildMultipartFileBody("file", filename, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileBuffer);
  const base = `${ZOHO_CRM_BASE.replace(/\/$/, "")}/`;
  const apiUrl = new URL(`${moduleName}/${recordId}/Attachments`, base);

  return requestJson(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
      "Content-Length": multipart.body.length,
    },
    body: multipart.body,
  });
}

function zohoUpdateRecord(moduleName, recordId, fields, accessToken) {
  const base = `${ZOHO_CRM_BASE.replace(/\/$/, "")}/`;
  const apiUrl = new URL(`${moduleName}/${recordId}`, base);
  const body = JSON.stringify({
    data: [Object.assign({ id: recordId }, fields)],
  });

  return requestJson(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
}

function zohoCreateRecord(moduleName, fields, accessToken) {
  const base = `${ZOHO_CRM_BASE.replace(/\/$/, "")}/`;
  const apiUrl = new URL(moduleName, base);
  const body = JSON.stringify({
    data: [removeUndefinedFields(fields)],
  });

  return requestJson(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
}

function zohoSearchRecords(moduleName, query, accessToken) {
  const base = `${ZOHO_CRM_BASE.replace(/\/$/, "")}/`;
  const apiUrl = new URL(`${moduleName}/search`, base);
  if (moduleName === "Contacts" && query.includes("@")) {
    apiUrl.searchParams.set("email", query);
  } else {
    apiUrl.searchParams.set("word", query);
  }
  apiUrl.searchParams.set("per_page", "10");

  return requestJson(apiUrl, {
    method: "GET",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });
}

function removeUndefinedFields(fields) {
  const cleaned = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value !== undefined && value !== null && value !== "") cleaned[key] = value;
  }
  return cleaned;
}

async function handleZiaToolRequest(req, res, url) {
  if (!isZiaToolAuthorized(req)) {
    return sendError(res, 401, "No autorizado para custom tools de Zia.");
  }

  if (url.pathname === "/api/zia/tools/ping") {
    return sendJson(res, {
      ok: true,
      service: "bessel-bom-tools",
      time: new Date().toISOString(),
    });
  }

  if (url.pathname === "/api/zia/quote/read" && req.method === "POST") {
    const body = await readJsonBody(req);
    const quoteId = extractQuoteId(body.quoteUrl || body.quoteId || "");
    if (!quoteId) return sendError(res, 400, "Falta quoteId o quoteUrl valido.");

    const token = await getZohoAccessToken();
    const quote = await zohoGet(`/Quotes/${quoteId}`, token.access_token);
    const record = quote && quote.data && quote.data[0] ? quote.data[0] : null;
    if (!record) return sendError(res, 404, "Zoho no devolvio datos para ese presupuesto.");

    return sendJson(res, {
      ok: true,
      quote: summarizeQuote(record),
      raw: body.includeRaw === true ? record : undefined,
    });
  }

  if (url.pathname === "/api/zia/products/search" && req.method === "POST") {
    const body = await readJsonBody(req);
    const query = String(body.query || "").trim();
    if (!query) return sendError(res, 400, "Falta query para buscar productos.");

    const token = await getZohoAccessToken();
    const result = await zohoSearchRecords("Products", query, token.access_token);
    return sendJson(res, {
      ok: true,
      query,
      products: summarizeZohoRecords("Products", result.data || []),
    });
  }

  if (url.pathname === "/api/zia/exchange/read") {
    const exchange = await buildExchangeContext();
    return sendJson(res, {
      ok: true,
      exchange,
    });
  }

  if (url.pathname === "/api/zia/quote/update" && req.method === "POST") {
    const body = await readJsonBody(req);
    const quoteId = extractQuoteId(body.quoteUrl || body.quoteId || "");
    if (!quoteId) return sendError(res, 400, "Falta quoteId o quoteUrl valido.");

    const fields = sanitizeZiaQuoteUpdateFields(body.fields || {});
    if (!Object.keys(fields).length) return sendError(res, 400, "No hay campos permitidos para actualizar.");

    const token = await getZohoAccessToken();
    const update = await zohoUpdateRecord("Quotes", quoteId, fields, token.access_token);
    const reread = await zohoGet(`/Quotes/${quoteId}`, token.access_token);
    const record = reread && reread.data && reread.data[0] ? reread.data[0] : null;
    return sendJson(res, {
      ok: true,
      quoteId,
      updatedFields: fields,
      update,
      quote: record ? summarizeQuote(record) : null,
    });
  }

  if (url.pathname === "/api/zia/bom/generate-and-attach" && req.method === "POST") {
    const body = await readJsonBody(req);
    const quoteId = extractQuoteId(body.quoteUrl || body.quoteId || "");
    if (!quoteId) return sendError(res, 400, "Falta quoteId o quoteUrl valido.");

    const token = await getZohoAccessToken();
    const quote = await zohoGet(`/Quotes/${quoteId}`, token.access_token);
    const record = quote && quote.data && quote.data[0] ? quote.data[0] : null;
    if (!record) return sendError(res, 404, "Zoho no devolvio datos para ese presupuesto.");

    const summary = summarizeQuote(record);
    bomState = createEmptyBomState(summary);
    lastQuoteContext = {
      quote: summary,
      bomAnalysis: analyzeBom(summary),
    };
    if (body.bomState && typeof body.bomState === "object") {
      applyManualBomState(body.bomState);
    }

    const preview = await buildBomPreview();
    const filename = `${safeFileName(body.filename || preview.title || "BOM")}.xlsx`;
    const fileBuffer = buildXlsxFile(preview.tabs);
    const upload = await zohoUploadAttachment("Quotes", quoteId, filename, fileBuffer, token.access_token);
    const update = await zohoUpdateRecord("Quotes", quoteId, { Costos: "adjunto" }, token.access_token);
    const reread = await zohoGet(`/Quotes/${quoteId}`, token.access_token);
    const confirmedRecord = reread && reread.data && reread.data[0] ? reread.data[0] : null;
    const confirmedQuote = confirmedRecord ? summarizeQuote(confirmedRecord) : null;

    return sendJson(res, {
      ok: true,
      quoteId,
      filename,
      totals: preview.totals,
      upload,
      update,
      quote: confirmedQuote,
      costsUpdated: confirmedQuote ? confirmedQuote.costs === "adjunto" : false,
    });
  }

  return sendError(res, 404, "Custom tool no encontrada.");
}

function isZiaToolAuthorized(req) {
  const secret = String(process.env.ZIA_TOOL_SECRET || "").trim();
  if (!secret) return false;
  const header = String(req.headers.authorization || "");
  const expected = `Bearer ${secret}`;
  const headerBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);
  return headerBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(headerBuffer, expectedBuffer);
}

function sanitizeZiaQuoteUpdateFields(fields) {
  const allowed = new Set([
    "Costos",
    "Description",
    "Terms_and_Conditions",
    "Quote_Stage",
    "Valid_Till",
    "Subject",
  ]);
  const cleaned = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (allowed.has(key) && value !== undefined && value !== null) cleaned[key] = value;
  }
  return cleaned;
}

function optionalString(value) {
  const text = String(value || "").trim();
  return text || undefined;
}

function extractCreatedRecordId(response) {
  const first = response && response.data && response.data[0];
  return first && first.details && first.details.id ? first.details.id : "";
}

function assertZohoCreateSuccess(response) {
  const first = response && response.data && response.data[0];
  if (!first) throw new Error("Zoho no devolvio datos de creacion.");
  if (String(first.status || "").toLowerCase() === "error") {
    throw new Error(first.message || first.code || "Zoho rechazo la creacion del registro.");
  }
  if (!extractCreatedRecordId(response)) {
    throw new Error(first.message || first.code || "Zoho no devolvio el ID del registro creado.");
  }
}

function summarizeZohoRecords(moduleName, records) {
  if (moduleName === "Accounts") return records.map(summarizeAccount);
  if (moduleName === "Contacts") return records.map(summarizeContact);
  if (moduleName === "Products") return records.map(summarizeProduct);
  return records.map((record) => ({ id: record.id, name: lookupName(record) || record.Name || "" }));
}

function summarizeAccount(record) {
  return {
    id: record.id || "",
    name: record.Account_Name || "",
    phone: record.Phone || "",
    website: record.Website || "",
    owner: lookupName(record.Owner),
  };
}

function summarizeContact(record) {
  return {
    id: record.id || "",
    name: record.Full_Name || [record.First_Name, record.Last_Name].filter(Boolean).join(" "),
    firstName: record.First_Name || "",
    lastName: record.Last_Name || "",
    email: record.Email || "",
    phone: record.Phone || "",
    accountName: lookupName(record.Account_Name),
    accountId: lookupId(record.Account_Name),
    owner: lookupName(record.Owner),
  };
}

function summarizeProduct(record) {
  return {
    id: record.id || "",
    name: record.Product_Name || "",
    code: record.Product_Code || "",
    unitPrice: record.Unit_Price || record.List_Price || 0,
    costPrice: record.Cost_Price || record.Costo || record.Costo_USD || record.Costo_Unitario || "",
    qtyInStock: record.Qty_in_Stock ?? record.Quantity_in_Stock ?? record.Stock ?? record.Existencias ?? "",
    qtyOrdered: record.Qty_Ordered ?? "",
    reorderLevel: record.Reorder_Level ?? "",
    vendorName: lookupName(record.Vendor_Name || record.Vendor),
    category: record.Product_Category || "",
    description: record.Description || "",
    active: record.Product_Active,
    owner: lookupName(record.Owner),
  };
}

function buildMultipartFileBody(fieldName, filename, contentTypeValue, fileBuffer) {
  const boundary = `----bessel-bom-${crypto.randomBytes(12).toString("hex")}`;
  const header = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
      `Content-Type: ${contentTypeValue}`,
      "",
      "",
    ].join("\r\n"),
    "utf8"
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  return {
    boundary,
    body: Buffer.concat([header, fileBuffer, footer]),
  };
}

function mergeToken(previous, next) {
  const merged = Object.assign({}, previous || {}, next || {});
  if (next && next.expires_in) {
    merged.expires_at = Date.now() + Number(next.expires_in) * 1000;
  }
  return merged;
}

function loadSavedZohoToken(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function saveZohoToken(filePath, token) {
  if (dbPool) {
    dbSetJson("zoho_token", token || {});
    return;
  }
  fs.writeFileSync(filePath, JSON.stringify(token, null, 2), "utf8");
}

function saveBomDataSnapshot() {
  if (dbPool) {
    dbSetJson("bom_data", buildBomDataFile());
    return;
  }
  fs.writeFileSync(bomDataPath, JSON.stringify(buildBomDataFile(), null, 2), "utf8");
}

function buildBomDataFile() {
  return {
    savedAt: new Date().toISOString(),
    quote: lastQuoteContext ? lastQuoteContext.quote : null,
    bomState: buildEditableBomState(),
    conversationProgress: analyzeConversationProgress(),
  };
}

function applyManualBomState(nextState) {
  if (!nextState || typeof nextState !== "object") return;

  applyObjectFields(bomState.items, nextState.items, {
    productName: "string",
    quantity: "number",
    costUnitUsd: "number",
    provider: "string",
    paymentCondition: "string",
    marginDivisor: "number",
    observations: "string",
    confirmed: "boolean",
    costLocked: "boolean",
    marginLocked: "boolean",
  });

  if (nextState.items && Array.isArray(nextState.items.quoteLines)) {
    bomState.items.quoteLines = nextState.items.quoteLines.map((line) => normalizeManualQuoteLine(line));
    const firstLine = bomState.items.quoteLines[0];
    if (firstLine) {
      bomState.items.productName = firstLine.productName || "";
      bomState.items.quantity = numberOrNull(firstLine.quantity);
      bomState.items.costUnitUsd = numberOrNull(firstLine.costUnitUsd);
      bomState.items.provider = firstLine.provider || "";
      bomState.items.paymentCondition = firstLine.paymentCondition || "";
      bomState.items.observations = firstLine.description || "";
    }
  }

  applyObjectFields(bomState.labor, nextState.labor, {
    applies: "booleanOrNull",
    hours: "number",
    workType: "string",
    hourlyRateArs: "number",
  });

  applyObjectFields(bomState.insurance, nextState.insurance, {
    applies: "booleanOrNull",
    type: "string",
    insuredValueUsd: "number",
    rate: "number",
    confirmed: "boolean",
  });

  applyObjectFields(bomState.materials, nextState.materials, {
    hasExtras: "booleanOrNull",
    detail: "string",
    cost: "number",
  });

  applyObjectFields(bomState.logistics, nextState.logistics, {
    applies: "booleanOrNull",
    km: "number",
    destination: "string",
    rateUsdPerKm: "number",
    parkingUsd: "number",
  });

  applyObjectFields(bomState.exchange, nextState.exchange, {
    billSale: "number",
    currencySale: "number",
  });

  normalizeInsuranceDefaults();
  if (nextState.insurance && nextState.insurance.type) {
    bomState.insurance.confirmed = true;
  }

  if (allMainItemDataPresent()) {
    bomState.items.confirmed = true;
  }
}

function normalizeInsuranceDefaults() {
  bomState.insurance.applies = true;
  if (!bomState.insurance.type) bomState.insurance.type = "instalacion_nueva";
  if (bomState.insurance.type === "instalacion_nueva") bomState.insurance.rate = 0.01;
  if (bomState.insurance.type === "intervencion_equipo_cliente") bomState.insurance.rate = 0.03;
}

function normalizeManualQuoteLine(line) {
  const source = line && typeof line === "object" ? line : {};
  return {
    productName: String(source.productName || "").trim(),
    description: String(source.description || "").trim(),
    quantity: source.quantity === "" || source.quantity === null ? null : numberOrNull(source.quantity),
    costUnitUsd: source.costUnitUsd === "" || source.costUnitUsd === null ? null : numberOrNull(source.costUnitUsd),
    provider: String(source.provider || "").trim(),
    paymentCondition: String(source.paymentCondition || "").trim(),
  };
}

function applyObjectFields(target, source, schema) {
  if (!source || typeof source !== "object") return;

  for (const [key, type] of Object.entries(schema)) {
    if (!(key in source)) continue;

    if (type === "string") {
      target[key] = String(source[key] || "").trim();
    } else if (type === "number") {
      target[key] = source[key] === "" || source[key] === null ? null : numberOrNull(source[key]);
    } else if (type === "boolean") {
      target[key] = Boolean(source[key]);
    } else if (type === "booleanOrNull") {
      target[key] = parseBooleanOrNull(source[key]);
    }
  }
}

function parseBooleanOrNull(value) {
  if (value === true || value === "true" || value === "si") return true;
  if (value === false || value === "false" || value === "no") return false;
  return null;
}

function buildAdminPromptResponse(currentUser) {
  const basePrompt = buildBaseAgentInstructions();
  const files = readAdminContextFiles();
  const effectivePrompt = buildAgentInstructions();

  return {
    user: {
      username: currentUser.username,
      name: currentUser.name || "",
      email: currentUser.email || "",
      isAdmin: isAdminUser(currentUser),
    },
    basePrompt,
    files: files.map((file) => ({
      name: file.name,
      size: file.content.length,
      preview: file.content.slice(0, 500),
    })),
    effectivePrompt,
  };
}

function saveAdminContextFile(body) {
  const originalName = String(body.fileName || "").trim();
  if (!originalName) throw new Error("Falta el nombre del archivo.");

  const promptBeforeUpload = readAdminPrompt() || buildDefaultAgentInstructions();
  const safeName = safeFileName(originalName);
  const extension = path.extname(safeName).toLowerCase();
  let content = "";

  if (extension === ".docx") {
    content = extractDocxTextFromBase64(String(body.contentBase64 || ""));
  } else {
    content = String(body.content || "");
  }

  content = content.trim();
  if (!content) throw new Error("No pude extraer texto del archivo.");

  const outputName = `${Date.now()}-${safeName.replace(/\.[^.]+$/, "")}.txt`;
  if (dbPool) {
    adminFilesCache.push({ name: outputName, content });
    dbPool
      .query(
        `INSERT INTO admin_files (name, content, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (name) DO UPDATE SET content = EXCLUDED.content`,
        [outputName, content]
      )
      .catch((error) => console.error("No pude guardar archivo admin en Neon:", error.message));
    appendContextToAdminPrompt(promptBeforeUpload, outputName, content);
    return;
  }

  fs.writeFileSync(path.join(adminFilesDir, outputName), content, "utf8");
  appendContextToAdminPrompt(promptBeforeUpload, outputName, content);
}

function readAdminPrompt() {
  if (dbPool) return adminPromptCache;
  try {
    if (!fs.existsSync(adminPromptPath)) return "";
    return fs.readFileSync(adminPromptPath, "utf8").trim();
  } catch (error) {
    return "";
  }
}

function saveAdminPrompt(prompt) {
  const cleaned = String(prompt || "").trim();
  if (!cleaned) throw new Error("El prompt no puede quedar vacio.");
  if (dbPool) {
    adminPromptCache = cleaned;
    dbSetJson("admin_prompt", { prompt: cleaned });
    return;
  }
  fs.writeFileSync(adminPromptPath, cleaned, "utf8");
}

function appendContextToAdminPrompt(currentPrompt, fileName, content) {
  const block = [
    "",
    "",
    "Contexto subido por administrador:",
    `Archivo: ${fileName}`,
    content.trim(),
  ].join("\n");

  saveAdminPrompt(`${String(currentPrompt || "").trim()}${block}`);
}

function deleteAdminContextFile(name) {
  const safeName = safeFileName(name);
  if (!safeName || safeName !== name) throw new Error("Nombre de archivo no valido.");

  if (dbPool) {
    adminFilesCache = adminFilesCache.filter((file) => file.name !== safeName);
    dbPool.query("DELETE FROM admin_files WHERE name = $1", [safeName]).catch((error) => console.error("No pude borrar archivo admin en Neon:", error.message));
    removeContextBlockFromAdminPrompt(safeName);
    return;
  }

  const filePath = path.join(adminFilesDir, safeName);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(adminFilesDir))) {
    throw new Error("Ruta de archivo no permitida.");
  }

  if (fs.existsSync(resolved)) {
    fs.unlinkSync(resolved);
  }

  removeContextBlockFromAdminPrompt(safeName);
}

function removeContextBlockFromAdminPrompt(fileName) {
  const prompt = readAdminPrompt();
  if (!prompt) return;

  const escaped = escapeRegExp(fileName);
  const pattern = new RegExp(`\\n*Contexto subido por administrador:\\nArchivo: ${escaped}\\n[\\s\\S]*?(?=\\n\\nContexto subido por administrador:\\nArchivo: |$)`, "g");
  const cleaned = prompt.replace(pattern, "").trim();

  if (cleaned) {
    saveAdminPrompt(cleaned);
  } else if (dbPool) {
    adminPromptCache = "";
    dbSetJson("admin_prompt", { prompt: "" });
  } else if (fs.existsSync(adminPromptPath)) {
    fs.unlinkSync(adminPromptPath);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readAdminContextFiles() {
  if (dbPool) return adminFilesCache.slice();
  try {
    if (!fs.existsSync(adminFilesDir)) return [];
    return fs
      .readdirSync(adminFilesDir)
      .filter((name) => name.toLowerCase().endsWith(".txt"))
      .sort()
      .map((name) => ({
        name,
        content: fs.readFileSync(path.join(adminFilesDir, name), "utf8").trim().slice(0, 12000),
      }))
      .filter((file) => file.content);
  } catch (error) {
    return [];
  }
}

function safeFileName(name) {
  return String(name || "contexto.txt")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function extractDocxTextFromBase64(base64) {
  const buffer = Buffer.from(base64, "base64");
  const xml = extractZipTextEntry(buffer, "word/document.xml");
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractZipTextEntry(buffer, entryName) {
  const zlib = require("zlib");
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) throw new Error("El archivo DOCX no parece valido.");

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) break;

    const compression = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
    const fileName = buffer.slice(centralOffset + 46, centralOffset + 46 + fileNameLength).toString("utf8");

    if (fileName === entryName) {
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);
      if (compression === 0) return compressed.toString("utf8");
      if (compression === 8) return zlib.inflateRawSync(compressed).toString("utf8");
      throw new Error("El tipo de compresion del DOCX no esta soportado.");
    }

    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error("No encontre texto principal dentro del DOCX.");
}

function findEndOfCentralDirectory(buffer) {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadUsers(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed.users) && parsed.users.length) return parsed.users;
    }
  } catch (error) {
    console.warn(`No pude leer usuarios: ${error.message}`);
  }

  const initialUsers = createInitialUsers();
  fs.writeFileSync(filePath, JSON.stringify({ users: initialUsers }, null, 2), "utf8");
  console.log(`Usuarios iniciales creados: ${initialUsers.map((user) => user.username).join(", ")}`);
  if (!process.env.INITIAL_ADMIN_PASSWORD) {
    console.log("Contraseña inicial temporal: Cambiar123!");
  }
  return initialUsers;
}

function createInitialUsers() {
  const usersList = [createInitialAdminUser()];
  const commercialUsername = process.env.INITIAL_COMMERCIAL_USERNAME || "german.planes@bessel.com.ar";
  if (commercialUsername) {
    usersList.push(
      createUserRecord({
        username: commercialUsername,
        password: process.env.INITIAL_COMMERCIAL_PASSWORD || "123456",
        name: process.env.INITIAL_COMMERCIAL_NAME || "German Planes",
        email: process.env.INITIAL_COMMERCIAL_EMAIL || commercialUsername,
        role: "comercial",
      })
    );
  }
  return usersList;
}

function createInitialAdminUser() {
  return createUserRecord({
    username: process.env.INITIAL_ADMIN_USERNAME || CURRENT_USER || "admin",
    password: process.env.INITIAL_ADMIN_PASSWORD || "Cambiar123!",
    name: process.env.INITIAL_ADMIN_NAME || "Juan Ignacio Vidal Bruni",
    email: process.env.INITIAL_ADMIN_EMAIL || "ignacio.vidalbruni@bessel.com.ar",
    role: "administrador",
  });
}

function createUserRecord(input) {
  const salt = crypto.randomBytes(16).toString("hex");
  const iterations = 310000;
  return {
    username: String(input.username || "").trim(),
    name: String(input.name || "").trim(),
    email: String(input.email || "").trim(),
    role: String(input.role || "comercial").trim(),
    passwordSalt: salt,
    passwordIterations: iterations,
    passwordHash: hashPassword(input.password, salt, iterations),
    createdAt: new Date().toISOString(),
  };
}

function hashPassword(password, salt, iterations) {
  return crypto.pbkdf2Sync(String(password || ""), salt, iterations, 32, "sha256").toString("hex");
}

function verifyPassword(password, user) {
  if (!user || !user.passwordHash || !user.passwordSalt) return false;
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, user.passwordSalt, user.passwordIterations || 310000), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function verifyLogin(username, password) {
  const normalized = String(username || "").trim().toLowerCase();
  const user = users.find((item) => String(item.username || "").toLowerCase() === normalized || String(item.email || "").toLowerCase() === normalized);
  return verifyPassword(password, user) ? user : null;
}

function createAuthSession(user) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  authSessions.set(sessionId, {
    username: user.username,
    createdAt: Date.now(),
    expiresAt: Date.now() + 1000 * 60 * 60 * 12,
  });
  return sessionId;
}

function getAuthenticatedUser(req) {
  const sessionId = readCookie(req, "bom_session");
  if (!sessionId) return null;
  const session = authSessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    authSessions.delete(sessionId);
    return null;
  }

  return users.find((item) => item.username === session.username) || null;
}

function publicUser(user) {
  return {
    username: user.username,
    name: user.name || "",
    email: user.email || "",
    role: user.role || "comercial",
    isAdmin: isAdminUser(user),
  };
}

function isAdminUser(user) {
  if (!user) return false;
  if (String(user.role || "").toLowerCase() === "administrador") return true;
  const identifiers = [user.username, user.email].map((item) => String(item || "").toLowerCase());
  return ADMIN_USERS.map((item) => item.toLowerCase()).some((item) => identifiers.includes(item));
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index === -1) continue;
    const key = cookie.slice(0, index).trim();
    if (key === name) return decodeURIComponent(cookie.slice(index + 1).trim());
  }
  return "";
}

function authCookie(sessionId) {
  const secure = ZOHO_REDIRECT_URI.startsWith("https://") ? "; Secure" : "";
  return `bom_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`;
}

function clearAuthCookie() {
  const secure = ZOHO_REDIRECT_URI.startsWith("https://") ? "; Secure" : "";
  return `bom_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function isPublicAssetPath(pathname) {
  return ["/styles.css", "/login.js"].includes(pathname);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5000000) {
        reject(new Error("El pedido es demasiado grande."));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error("El cuerpo del pedido no es JSON valido."));
      }
    });
    req.on("error", reject);
  });
}

function extractQuoteId(value) {
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) return text;

  const match = text.match(/\/Quotes\/(\d+)/i);
  if (match) return match[1];

  return "";
}

function summarizeQuote(record) {
  return {
    id: record.id,
    subject: record.Subject || record.Quote_Name || record.Quote_No || "",
    quoteNumber: record.Quote_Number || record.Quote_No || "",
    accountName: lookupName(record.Account_Name),
    contactName: lookupName(record.Contact_Name),
    status: record.Quote_Stage || record.Stage || record.Status || "",
    costs: record.Costos || "",
    currency: record.Currency || "",
    grandTotal: record.Grand_Total,
    validTill: record.Valid_Till || "",
    productDetails: summarizeProducts(extractQuoteLineItems(record)),
  };
}

function extractQuoteLineItems(record) {
  const candidates = [
    record.Quoted_Items,
    record.Product_Details,
    record.Line_Items,
    record.Items,
    record.Item_Details,
    record.Products,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }

  return [];
}

function analyzeBom(summary) {
  const questions = [];
  const warnings = [];
  const detected = [];
  const items = summary.productDetails || [];

  if (!summary.costs) {
    detected.push("El campo Costos esta vacio.");
  } else {
    detected.push(`El campo Costos ya tiene valor: ${summary.costs}.`);
  }

  if (!items.length) {
    warnings.push("El presupuesto no tiene items cargados.");
  }

  const zeroPriceItems = items.filter((item) => Number(item.listPrice || 0) === 0);
  if (zeroPriceItems.length) {
    warnings.push("Hay items con precio de lista en cero.");
  }

  for (const item of items) {
    if (item.productName) {
      detected.push(`Item detectado: ${item.productName}, cantidad ${item.quantity || 0}.`);
    }
  }

  if (items.length) {
    questions.push("Para los items principales, voy a asumir costos en USD. Indicame solo costo unitario USD de cada item y margen divisor general.");
    questions.push("Indica el margen divisor general para los items principales, salvo que quieras margenes distintos por item.");
  }

  if (zeroPriceItems.length) {
    questions.push("Los items del presupuesto estan en cero. Queres que busque costos/stock en Zoho por estos productos?");
  }

  questions.push("Cuando cerremos items principales, confirmame si hay mano de obra.");
  questions.push("Si hay mano de obra, despues pedire horas y tipo de trabajo. Gestion/documentacion y seguro se incluyen segun reglas.");

  return {
    readyForBom: false,
    detected,
    warnings,
    questions,
    nextAction: "Pedir al comercial los datos faltantes antes de generar el BOM.",
  };
}

function createEmptyBomState(summary) {
  const firstProduct = summary && summary.productDetails && summary.productDetails[0];

  return {
    items: {
      productName: firstProduct ? firstProduct.productName : "",
      quantity: firstProduct ? firstProduct.quantity : null,
      quoteLines: summary && Array.isArray(summary.productDetails) ? summary.productDetails : [],
      costUnitUsd: null,
      provider: "",
      paymentCondition: "",
      marginDivisor: null,
      observations: "",
      confirmed: false,
      costLocked: false,
      marginLocked: false,
    },
    labor: {
      applies: null,
      hours: null,
      workType: "",
      hourlyRateArs: 20000,
    },
    admin: {
      managementDocumentationHours: null,
    },
    insurance: {
      applies: true,
      type: "instalacion_nueva",
      insuredValueUsd: null,
      rate: 0.01,
      confirmed: false,
    },
    materials: {
      hasExtras: null,
      detail: "",
      cost: null,
    },
    logistics: {
      applies: null,
      km: null,
      destination: "",
      parkingUsd: 20,
      rateUsdPerKm: 0.71,
    },
    exchange: {
      billSale: null,
      currencySale: null,
    },
  };
}

function updateBomStateFromUser(message, previousStage) {
  const raw = String(message || "");
  const text = normalizeForStage(raw);
  const briefYes = /^(si|sí|s|ok|dale|correcto|afirmativo)\.?$/.test(raw.trim().toLowerCase());
  const briefNo = /^(no|n|negativo)\.?$/.test(raw.trim().toLowerCase());
  const lastAssistant = normalizeForStage(lastAssistantMessage());
  const yes = briefYes || /^(si|s|ok|dale|correcto|afirmativo)\.?$/.test(text.trim());
  const no = briefNo || /^(no|n|negativo)\.?$/.test(text.trim());

  if (previousStage === "items_principales" && yes && /confirmas|confirmas|confirmar/.test(lastAssistant)) {
    updateMainItemStateFromText(lastAssistant, { allowFallbackCost: true });
    bomState.items.confirmed = allMainItemDataPresent();
  }

  if (previousStage === "definir_si_hay_mano_de_obra") {
    if (yes) {
      bomState.labor.applies = true;
      bomState.admin.managementDocumentationHours = 1;
      bomState.insurance.applies = true;
    }
    if (no) bomState.labor.applies = false;
  }

  if (previousStage === "materiales_extra") {
    if (no) {
      bomState.materials.hasExtras = false;
      bomState.materials.cost = 0;
    }
    if (yes) bomState.materials.hasExtras = true;
  }

  if (previousStage === "viaticos_logistica") {
    if (no) bomState.logistics.applies = false;
    if (yes) bomState.logistics.applies = true;
  }

  if (previousStage === "seguro_tipo_valor") {
    if (/\b(instalacion nueva|equipo nuevo|equipos nuevos|nuevo)\b/.test(text) || yes) {
      bomState.insurance.applies = true;
      bomState.insurance.type = "instalacion_nueva";
      bomState.insurance.rate = 0.01;
      bomState.insurance.confirmed = true;
    }
    if (/\b(intervencion|intervenir|equipo del cliente|ups del cliente|mantenimiento)\b/.test(text)) {
      bomState.insurance.applies = true;
      bomState.insurance.type = "intervencion_equipo_cliente";
      bomState.insurance.rate = 0.03;
      bomState.insurance.confirmed = true;
    }
  }

  if (previousStage === "proveedor_condicion_pago") {
    updateProviderPaymentForCurrentItem(raw, text);
  }

  updateMainItemStateFromText(text, { allowFallbackCost: previousStage === "items_principales" });

  if (/\b(sin servicio|sin mano de obra|solo venta|solo producto|no hay servicio|no hay mano de obra)\b/.test(text)) {
    bomState.labor.applies = false;
  }
  if (/\b(hay mano de obra|incluye mano de obra|con mano de obra|hay servicio|incluye servicio|con servicio|servicio en sitio|en sitio)\b/.test(text)) {
    bomState.labor.applies = true;
    bomState.admin.managementDocumentationHours = 1;
    bomState.insurance.applies = true;
  }

  const hours = text.match(/\b(\d+(?:\.\d+)?)\s*(h|hs|hora|horas)\b/);
  if (hours) bomState.labor.hours = Number(hours[1]);
  if (previousStage === "mano_de_obra_horas_tipo" && bomState.labor.hours === null) {
    const fallbackHours = allNumbers(text).find((number) => number > 0 && number <= 24);
    if (fallbackHours !== undefined) bomState.labor.hours = fallbackHours;
  }

  if (/\b(cambio|instalacion|calibracion|reparacion|mantenimiento|service)\b/.test(text)) {
    bomState.labor.workType = raw.trim();
  }
  if (previousStage === "mano_de_obra_horas_tipo" && !bomState.labor.workType && raw.trim() && !/^\d+(?:[.,]\d+)?$/.test(raw.trim())) {
    bomState.labor.workType = raw.trim();
  }

  if (/\b(instalacion nueva|equipo nuevo|equipos nuevos)\b/.test(text)) {
    bomState.insurance.applies = true;
    bomState.insurance.type = "instalacion_nueva";
    bomState.insurance.rate = 0.01;
    bomState.insurance.confirmed = true;
  }
  if (/\b(intervencion|intervenir|equipo del cliente|ups del cliente|mantenimiento)\b/.test(text)) {
    bomState.insurance.applies = true;
    bomState.insurance.type = "intervencion_equipo_cliente";
    bomState.insurance.rate = 0.03;
    bomState.insurance.confirmed = true;
  }
  const insuredValue = firstNumberAfter(text, ["valor", "vale", "valuado", "asegurado"]);
  if (insuredValue !== null) bomState.insurance.insuredValueUsd = insuredValue;

  if (/\b(sin materiales|no hay materiales|materiales 0|sin materiales extra|no hay materiales extra)\b/.test(text)) {
    bomState.materials.hasExtras = false;
    bomState.materials.cost = 0;
  } else if (/\b(materiales extra|material extra)\b/.test(text)) {
    bomState.materials.hasExtras = true;
    bomState.materials.detail = raw.trim();
    const materialCost = firstNumberAfter(text, ["materiales", "material", "costo"]);
    if (materialCost !== null) bomState.materials.cost = materialCost;
  }

  if (/\b(sin viaticos|sin logistica|no hay viaticos|no hay logistica)\b/.test(text)) {
    bomState.logistics.applies = false;
  }
  if (/\b(viatico|viaticos|logistica|traslado|estacionamiento|km|kilometro|destino)\b/.test(text)) {
    bomState.logistics.applies = true;
  }
  const km = text.match(/\b(\d+(?:\.\d+)?)\s*(km|kilometro|kilometros)\b/);
  if (km) {
    bomState.logistics.applies = true;
    bomState.logistics.km = Number(km[1]);
  }

  const destination = raw.match(/\b(?:destino|zona|en|a)\s+(.+)$/i);
  if (destination && destination[1] && bomState.logistics.applies !== false) {
    bomState.logistics.applies = true;
    bomState.logistics.destination = cleanShortValue(destination[1]);
  }

  if (allMainItemDataPresent()) {
    bomState.items.confirmed = true;
  }
}

function firstNumberAfter(text, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}[^0-9]{0,20}(\\d+(?:\\.\\d+)?)`));
    if (match) return Number(match[1]);
  }

  return null;
}

function updateMainItemStateFromText(text, options) {
  const allowFallbackCost = Boolean(options && options.allowFallbackCost);
  const explicitEdit = allowsLockedMainItemEdit(text);
  const cost = explicitEdit ? extractExplicitReplacementCost(text) ?? extractItemCostUsd(text, allowFallbackCost) : extractItemCostUsd(text, allowFallbackCost);
  if (cost !== null) setNextMainItemCost(cost, explicitEdit, text);

  const margin = extractMarginDivisor(text);
  if (margin !== null && (!bomState.items.marginLocked || explicitEdit)) {
    bomState.items.marginDivisor = margin;
    bomState.items.marginLocked = true;
  }
}

function allowsLockedMainItemEdit(text) {
  return /\b(cambiar|cambia|corregir|corrige|modificar|modifica|editar|edita|actualizar|actualiza|reemplazar|reemplaza|sobreescribir)\b/.test(text);
}

function setNextMainItemCost(cost, explicitEdit, text) {
  const lines = editableQuoteLines();
  const missingIndex = lines.findIndex((line) => numberOrNull(line.costUnitUsd) === null);
  const explicitIndex = findItemIndexFromText(text);
  const targetIndex = explicitEdit && explicitIndex !== null ? explicitIndex : missingIndex >= 0 ? missingIndex : 0;

  if (missingIndex === -1 && bomState.items.costLocked && !explicitEdit) return;
  if (!lines[targetIndex]) return;

  lines[targetIndex].costUnitUsd = cost;
  if (targetIndex === 0) bomState.items.costUnitUsd = cost;
  if (allMainItemCostsPresent()) bomState.items.costLocked = true;
}

function extractExplicitReplacementCost(text) {
  const numbers = allNumbers(text).filter((number) => number > 1);
  if (!numbers.length) return null;
  return numbers[numbers.length - 1];
}

function findItemIndexFromText(text) {
  const match = String(text || "").match(/\bitem\s*(\d+)\b/);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function extractItemCostUsd(text, allowFallback) {
  const patterns = [
    /\b(?:usd|u\$s|us\$)\s*(\d+(?:\.\d+)?)/,
    /\b(\d+(?:\.\d+)?)\s*(?:usd|u\$s|us\$)\b/,
    /\b(?:costo|cuesta|unitario|precio)\b[^0-9]{0,30}(\d+(?:\.\d+)?)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  if (!allowFallback) return null;

  const numbers = allNumbers(text).filter((number) => number > 1);
  if (!numbers.length) return null;

  const quantity = numberOrNull(bomState.items.quantity);
  const filtered = quantity ? numbers.filter((number) => number !== quantity) : numbers;
  return filtered.length ? filtered[0] : numbers[0];
}

function extractMarginDivisor(text) {
  const labeled = firstNumberAfter(text, ["margen", "marginar", "divisor"]);
  if (labeled !== null) return labeled;

  const decimal = allNumbers(text).find((number) => number > 0 && number < 1);
  return decimal === undefined ? null : decimal;
}

function extractProvider(text) {
  const labeled = text.match(/\bproveedor\s+([a-z0-9 ._-]+)/);
  if (labeled && labeled[1]) return cleanItemValue(labeled[1]);

  const knownProvider = text.match(/\b(distecna|isecom|stock propio)\b/);
  return knownProvider ? knownProvider[1] : "";
}

function extractPaymentCondition(text) {
  const labeled = text.match(/\b(?:pago|condicion|condicion de pago)\s+([a-z0-9 ._-]+)/);
  if (labeled && labeled[1]) return cleanItemValue(labeled[1]);

  const simplePayment = text.match(/\b(anticipado|contado|transferencia|\d+\s*dias)\b/);
  return simplePayment ? simplePayment[1] : "";
}

function updateProviderPaymentForCurrentItem(raw, text) {
  const index = nextProviderPaymentIndex();
  const lines = editableQuoteLines();
  const line = lines[index] || lines[0];
  if (!line) return;

  const provider = extractProvider(text) || inferProviderFromFreeText(raw, text);
  const payment = extractPaymentCondition(text);

  if (provider) line.provider = provider;
  if (payment) line.paymentCondition = payment;

  if (index === 0) {
    if (provider) bomState.items.provider = provider;
    if (payment) bomState.items.paymentCondition = payment;
  }
}

function inferProviderFromFreeText(raw, text) {
  const payment = extractPaymentCondition(text);
  let candidate = String(raw || "")
    .replace(new RegExp(payment || "$^", "i"), " ")
    .replace(/\b(proveedor|condicion|condicion de pago|pago|contado|anticipado|transferencia|\d+\s*dias)\b/gi, " ")
    .split(/[,;/-]/)[0]
    .trim();

  if (!candidate || allNumbers(candidate).length) return "";
  return cleanShortValue(candidate);
}

function editableQuoteLines() {
  if (!Array.isArray(bomState.items.quoteLines)) bomState.items.quoteLines = [];
  if (!bomState.items.quoteLines.length) {
    bomState.items.quoteLines.push({
      productName: bomState.items.productName || "Item principal",
      quantity: bomState.items.quantity || 1,
    });
  }
  return bomState.items.quoteLines;
}

function allMainItemCostsPresent() {
  return editableQuoteLines().every((line, index) => {
    const value = index === 0 ? numberOrNull(line.costUnitUsd) ?? numberOrNull(bomState.items.costUnitUsd) : numberOrNull(line.costUnitUsd);
    return value !== null;
  });
}

function providerPaymentComplete() {
  return editableQuoteLines().every((line, index) => {
    const provider = line.provider || (index === 0 ? bomState.items.provider : "");
    const payment = line.paymentCondition || (index === 0 ? bomState.items.paymentCondition : "");
    return Boolean(provider) && Boolean(payment);
  });
}

function nextProviderPaymentIndex() {
  const lines = editableQuoteLines();
  const index = lines.findIndex((line, lineIndex) => {
    const provider = line.provider || (lineIndex === 0 ? bomState.items.provider : "");
    const payment = line.paymentCondition || (lineIndex === 0 ? bomState.items.paymentCondition : "");
    return !provider || !payment;
  });
  return index === -1 ? 0 : index;
}

function allNumbers(text) {
  const matches = String(text || "").match(/\d+(?:\.\d+)?/g) || [];
  return matches.map(Number).filter((number) => Number.isFinite(number));
}

function cleanShortValue(value) {
  return String(value || "")
    .split(/[,.]/)[0]
    .trim()
    .slice(0, 80);
}

function cleanItemValue(value) {
  return cleanShortValue(
    String(value || "")
      .split(/\b(?:pago|condicion|margen|divisor|costo|precio|unitario|usd|u\$s|us\$|con|y)\b/)[0]
      .trim()
  );
}

async function buildZohoChatLookupContext(message) {
  if (!shouldSearchZohoProducts(message)) return null;

  const query = extractZohoProductQuery(message) || bomState.items.productName || "";
  if (!query) {
    return {
      type: "zoho_product_search",
      requested: true,
      query: "",
      error: "No pude detectar que articulo buscar. Pedi al usuario nombre, codigo o modelo.",
      records: [],
    };
  }

  try {
    const token = await getZohoAccessToken();
    const result = await zohoSearchRecords("Products", query, token.access_token);
    const records = summarizeZohoRecords("Products", result.data || []);
    return {
      type: "zoho_product_search",
      requested: true,
      query,
      records,
      guidance:
        "Responder usando solo estos datos de Zoho. Si falta stock, precio o costo en los resultados, decir que Zoho no lo devolvio. No inventar valores.",
    };
  } catch (error) {
    return {
      type: "zoho_product_search",
      requested: true,
      query,
      error: error.message || "No pude buscar en Zoho.",
      records: [],
    };
  }
}

function shouldSearchZohoProducts(message) {
  const text = normalizeForStage(message);
  const asksZohoLookup = /\b(busca|buscar|buscame|consulta|consultar|zoho|crm)\b/.test(text);
  const asksProductData = /\b(producto|articulo|articulos|item|items|stock|precio|precios|costo|costos|existencia|disponible|disponibilidad|codigo|modelo)\b/.test(text);
  const asksCurrentQuoteItem = /\b(costo|stock|precio)\b/.test(text) && /\b(item|producto|articulo|presupuesto|cotizacion)\b/.test(text);
  return (asksZohoLookup && asksProductData) || asksCurrentQuoteItem;
}

function extractZohoProductQuery(message) {
  const raw = String(message || "").trim();
  const text = normalizeForStage(raw);
  const patterns = [
    /\b(?:producto|articulo|item|modelo|codigo)\s+(.+)$/i,
    /\b(?:stock|precio|precios|costo|costos|disponibilidad|existencia)\s+(?:de|del|para|por)\s+(.+)$/i,
    /\b(?:busca|buscar|buscame|consulta|consultar)\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match && match[1]) return cleanProductLookupQuery(match[1]);
  }

  if (/\b(item|producto|articulo)\s+(?:del|de la)?\s*(?:presupuesto|cotizacion)\b/.test(text)) {
    return bomState.items.productName || "";
  }

  return cleanProductLookupQuery(raw);
}

function cleanProductLookupQuery(value) {
  return String(value || "")
    .replace(/\b(en|de|del|la|el|los|las|zoho|crm|precio|precios|stock|costo|costos|producto|articulo|item|items|busca|buscar|buscame|consulta|consultar)\b/gi, " ")
    .replace(/[?¿:;,.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function askOpenAiAgent(message) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Falta configurar OPENAI_API_KEY en el archivo .env.");
  }

  const previousStage = analyzeConversationProgress().currentStage;
  const zohoLookupContext = await buildZohoChatLookupContext(message);
  chatHistory.push({ role: "user", content: message });
  updateBomStateFromUser(message, previousStage || lastAgentStage);
  trimChatHistory();

  const deterministicAnswer = deterministicNextAnswer(previousStage);
  if (deterministicAnswer && !zohoLookupContext) {
    chatHistory.push({ role: "assistant", content: deterministicAnswer });
    lastAgentStage = analyzeConversationProgress().currentStage;
    trimChatHistory();
    return deterministicAnswer;
  }

  const response = await openAiResponse({
    model: OPENAI_MODEL,
    instructions: buildAgentInstructions(),
    input: buildAgentInput(zohoLookupContext),
    max_output_tokens: 700,
  });

  const answer = cleanAgentAnswer(extractOpenAiText(response));
  chatHistory.push({ role: "assistant", content: answer });
  lastAgentStage = analyzeConversationProgress().currentStage;
  trimChatHistory();

  return answer;
}

function buildAgentInstructions() {
  const savedPrompt = readAdminPrompt();
  if (savedPrompt) return savedPrompt;
  return buildDefaultAgentInstructions();
}

function buildDefaultAgentInstructions() {
  const basePrompt = buildBaseAgentInstructions();
  const adminContext = buildAdminContextInstructions();
  return [basePrompt, adminContext].filter(Boolean).join("\n\n");
}

function buildBaseAgentInstructions() {
  return [
    "Sos el agente de la app Asistente para BOMs de Bessel.",
    "Actuas como asistente administrativo de comerciales para crear BOMs de presupuestos en Zoho CRM.",
    "Tu mision es ayudar a cargar el costeo completo, crear una hoja BOM y dejarla lista para asociar al presupuesto.",
    "Trabaja con precision, orden y por secciones. No hagas todas las preguntas juntas.",
    "Responde en espanol, con tono claro, administrativo y directo. Evita sonar robotico.",
    "No inventes costos, stock, proveedores, reglas internas ni datos de Zoho.",
    "No digas que adjuntaste, generaste archivo o modificaste Zoho. Esta version todavia solo conversa y analiza.",
    "",
    "Flujo obligatorio por etapas:",
    "1. Items principales: cerrar productos/equipos/baterias, cantidades, costo unitario USD de cada item y margen divisor general. No pedir proveedor ni condicion de pago en esta etapa.",
    "2. Mano de obra: solo avanzar cuando items principales esten claros. Preguntar si hay mano de obra. Si la hay, pedir horas y tipo de trabajo.",
    "3. Gestion/documentacion: si hay mano de obra, incluir gestion ingreso y documentacion internamente, sin explicar la regla salvo que el usuario pregunte.",
    "4. Seguro: siempre hay seguro. Por default es instalacion nueva. Si el usuario indica intervencion sobre equipo del cliente, cambiar internamente el tipo a intervencion y pedir valor del equipo solo si hace falta para calcular.",
    "5. Materiales extra: preguntar solo despues de cerrar mano de obra/seguro. Si no hay, cargar 0.",
    "6. Viaticos/logistica: preguntar si hay logistica o viaticos. Si el usuario da km, tomarlos como solo ida. Si da destino o zona, usarlo para calcular km. Si da una zona y no una direccion exacta, calcular desde el epicentro de esa zona. Incluir estacionamiento internamente cuando hay logistica, sin aclararlo.",
    "7. Cierre: cuando tengas datos suficientes, no hagas resumen previo ni pidas confirmacion adicional; indica brevemente que ya se puede generar la BOM.",
    "",
    "Reglas de conversacion:",
    "Hace una sola pregunta principal por respuesta, salvo que el usuario pida un resumen.",
    "No tires una lista larga de preguntas. Avanza por partes.",
    "Si falta informacion critica, pedi solo el siguiente dato necesario.",
    "Si el usuario da varios datos juntos, absorbelos y pasa a la proxima brecha.",
    "No repitas los datos que el usuario acaba de dar, salvo que el usuario pida un resumen.",
    "No empieces respuestas con Entendido, Perfecto, Ok, Recibido o similares.",
    "Si el usuario contesta una pregunta, pasa directo a la siguiente pregunta.",
    "No pidas confirmar cada dato ya guardado en bomState. bomState es la fuente de verdad.",
    "Nunca vuelvas a items principales si bomState.items tiene costos y margen.",
    "Nunca vuelvas a mano de obra si bomState.labor.applies ya es true o false y la etapa actual esta despues.",
    "No uses markdown decorativo. No uses negritas, asteriscos dobles, listas largas ni tablas.",
    "Si hay un item en el presupuesto, partilo desde ese item. No preguntes genericamente como si no hubiera presupuesto.",
    "Cuando menciones el item, usa el nombre del producto visible en el contexto seguro.",
    "Obedece conversationProgress.currentStage por encima de palabras sueltas del historial.",
    "Si conversationProgress.items.likelyClosed es true, no vuelvas a pedir costo ni margen salvo que el usuario corrija esos datos.",
    "Si currentStage es items_principales, pregunta solamente costo unitario USD pendiente y margen divisor general.",
    "Si currentStage es definir_si_hay_mano_de_obra, pregunta solamente si hay mano de obra.",
    "Si currentStage es mano_de_obra_horas_tipo, pregunta solamente horas y tipo de trabajo.",
    "Si currentStage es materiales_extra, pregunta solamente si hay materiales extra; si no hay, cargar 0.",
    "Si currentStage es viaticos_logistica, pregunta solamente si hay logistica/viaticos y pide km, destino o zona.",
    "Si currentStage es proveedor_condicion_pago, pregunta solamente proveedor y condicion de pago del item indicado.",
    "Si el usuario confirma que no hay mano de obra, no preguntes seguro, gestion, horas, distancia ni estacionamiento salvo que mencione logistica por separado.",
    "No hagas resumen previo al cerrar la solicitud, salvo que el usuario lo pida explicitamente.",
    "Si currentStage es bom_listo_para_generar, no vuelvas a preguntar datos; indica que con esos datos ya se puede preparar el BOM.",
    "",
    "Reglas comerciales:",
    "Por default los items principales estan en USD.",
    "Solo pregunta moneda si el usuario aclara que algo no esta en USD o si hay ambiguedad.",
    "Pregunta un margen divisor general para todos los items principales.",
    "Solo maneja margenes distintos si el comercial lo aclara explicitamente.",
    "Si el presupuesto tiene precio/lista en cero, primero pregunta si debe buscar costo/stock en Zoho o si el comercial quiere pasarlo manualmente.",
    "Si el producto ya viene desde Zoho pero no hay costo disponible en el contexto, no lo inventes.",
    "Margen se carga como divisor, por ejemplo 0.75, no como porcentaje.",
    "Hay defaults internos para valor hora, gestion/documentacion, seguro, logistica, origen logistico y estacionamiento. No los menciones ni los expliques salvo que el usuario los pregunte explicitamente.",
    "Nunca aclares porcentajes de seguro, minimo de gestion/documentacion, direccion de origen logistico ni monto de estacionamiento.",
    "Si el usuario da kilometros, asumilos siempre como solo ida. No preguntes si son ida o vuelta.",
    "Para dolar divisa se usara BNA: billete venta / divisa venta. El ratio normalmente debe quedar entre 1 y 1.5.",
    "Si BNA no esta disponible, pedir confirmacion del TC antes de cerrar el BOM.",
    "",
    "Formato de respuesta:",
    "Maximo 2 lineas, salvo que el usuario pida detalle.",
    "No confirmes con una frase larga. En general, responde solo con la siguiente pregunta.",
    "Si necesitas mencionar un dato, hacelo sin negritas y sin asteriscos.",
    "No uses tablas todavia.",
  ].join("\n");
}

function buildAdminContextInstructions() {
  const parts = [];
  const files = readAdminContextFiles();

  for (const file of files) {
    parts.push(`Contexto subido por administrador - ${file.name}:\n${file.content}`);
  }

  if (!parts.length) return "";
  return ["Contexto administrativo adicional. Estas instrucciones complementan el prompt base; si hay conflicto, prioriza las reglas mas especificas y recientes del administrador.", ...parts].join("\n\n");
}

function buildAgentInput(zohoLookupContext) {
  const conversationProgress = analyzeConversationProgress();
  const context = {
    quoteContext: buildSafeQuoteContext(lastQuoteContext),
    bomState: buildSafeBomStateForAgent(),
    zohoLookupContext,
    conversationProgress,
    suggestedWorkflowStage: conversationProgress.currentStage,
    chatHistory,
  };

  return [
    {
      role: "user",
      content: `Contexto actual de la cotizacion y conversacion:\n${JSON.stringify(context, null, 2)}`,
    },
  ];
}

function analyzeConversationProgress() {
  const userMessages = chatHistory
    .filter((item) => item.role === "user")
    .map((item) => normalizeForStage(item.content))
    .join("\n");

  const items = {
    costMentioned: allMainItemCostsPresent() || /\b(costo|cuesta|unitario|usd|u\$s|us\$|\$)\b.*\d|\d+(\.\d+)?\s*(usd|u\$s|us\$|\$)/.test(userMessages),
    marginMentioned: bomState.items.marginDivisor !== null || /\b(margen|marginar|divisor)\b.*\d|0\.\d+/.test(userMessages),
  };
  items.likelyClosed =
    bomState.items.confirmed ||
    (allMainItemCostsPresent() && items.marginMentioned);

  const service = {
    explicitlyDenied: bomState.labor.applies === false || /\b(solo venta|sin servicio|sin mano de obra|no incluye servicio|no hay servicio|no hay mano de obra|solo producto|solo productos)\b/.test(userMessages),
    explicitlyConfirmed: bomState.labor.applies === true || /\b(incluye servicio|con servicio|servicio en sitio|en sitio|domicilio|instalacion|mano de obra|tecnico)\b/.test(userMessages),
    hoursMentioned: bomState.labor.hours !== null || /\b(\d+)\s*(h|hs|hora|horas)\b/.test(userMessages),
    workMentioned: Boolean(bomState.labor.workType) || /\b(cambio|instalacion|calibracion|reparacion|mantenimiento|service)\b/.test(userMessages),
  };

  const insurance = {
    confirmed: bomState.insurance.confirmed === true || /\b(seguro|equipo del cliente|intervencion|intervenir|instalacion nueva|equipo nuevo|ups del cliente)\b/.test(userMessages),
    valueMentioned: bomState.insurance.insuredValueUsd !== null || /\b(valor|vale|valuado|asegurado)\b.*\d|\d+(\.\d+)?\s*(usd|u\$s|us\$|\$)/.test(userMessages),
  };

  const extras = {
    mentioned: bomState.materials.hasExtras !== null || /\b(materiales extra|material extra|sin materiales|no hay materiales|materiales 0)\b/.test(userMessages),
  };

  const logistics = {
    mentioned: bomState.logistics.applies !== null || /\b(logistica|logistica|viatico|viaticos|km|kilometro|kilometros|destino|estacionamiento|traslado)\b/.test(userMessages),
  };

  return {
    items,
    service,
    insurance,
    extras,
    logistics,
    providerPayment: {
      complete: providerPaymentComplete(),
      currentIndex: nextProviderPaymentIndex(),
    },
    currentStage: currentWorkflowStage(items, service, insurance, extras, logistics),
  };
}

function currentWorkflowStage(items, service, insurance, extras, logistics) {
  if (!lastQuoteContext) return "sin_presupuesto_cargado";
  if (bomState.readyForBom) return "bom_listo_para_generar";
  if (!items.likelyClosed) return "items_principales";
  if (!service.explicitlyConfirmed && !service.explicitlyDenied) return "definir_si_hay_mano_de_obra";

  if (service.explicitlyConfirmed) {
    if (!service.workMentioned || !service.hoursMentioned) return "mano_de_obra_horas_tipo";
    if (!insurance.confirmed) return "seguro_tipo_valor";
    if (bomState.insurance.type === "intervencion_equipo_cliente" && !insurance.valueMentioned) return "seguro_tipo_valor";
    if (!extras.mentioned) return "materiales_extra";
    if (!logistics.mentioned) return "viaticos_logistica";
    if (!providerPaymentComplete()) return "proveedor_condicion_pago";
    return markBomReadyForGeneration();
  }

  if (!extras.mentioned) return "materiales_extra";
  if (!logistics.mentioned) return "viaticos_logistica";
  if (!providerPaymentComplete()) return "proveedor_condicion_pago";
  return markBomReadyForGeneration();
}

function markBomReadyForGeneration() {
  bomState.readyForBom = true;
  return "bom_listo_para_generar";
}

function deterministicNextAnswer(previousStage) {
  const currentStage = analyzeConversationProgress().currentStage;

  if (currentStage === "items_principales") {
    return nextMainItemQuestion();
  }

  if (currentStage === "definir_si_hay_mano_de_obra") {
    return "Hay mano de obra?";
  }

  if (currentStage === "mano_de_obra_horas_tipo") {
    const missing = [];
    if (bomState.labor.hours === null) missing.push("horas");
    if (!bomState.labor.workType) missing.push("tipo de trabajo");
    return `Me falta ${joinSpanishList(missing)} de mano de obra.`;
  }

  if (currentStage === "seguro_tipo_valor") {
    if (bomState.insurance.type === "intervencion_equipo_cliente" && bomState.insurance.insuredValueUsd === null) {
      return "Pasame el valor USD del equipo intervenido.";
    }
    return "El seguro es por instalacion nueva o intervencion?";
  }

  if (currentStage === "materiales_extra") {
    return "Hay materiales extra?";
  }

  if (currentStage === "viaticos_logistica") {
    return "Hay logistica o viaticos? Pasame km, destino o zona.";
  }

  if (currentStage === "proveedor_condicion_pago") {
    return nextProviderPaymentQuestion();
  }

  if (currentStage === "bom_listo_para_generar") {
    return "Datos completos. Ya podes generar la BOM.";
  }

  if (previousStage === "items_principales" && currentStage === "definir_si_hay_mano_de_obra") {
    return "Hay mano de obra?";
  }

  if (previousStage === "definir_si_hay_mano_de_obra" && currentStage === "mano_de_obra_horas_tipo") {
    return "Cuantas horas y que tipo de trabajo?";
  }

  if (previousStage === "definir_si_hay_mano_de_obra" && currentStage === "materiales_extra") {
    return "Hay materiales extra?";
  }

  return "";
}

function nextMainItemQuestion() {
  const missingCostIndex = editableQuoteLines().findIndex((line, index) => {
    const value = index === 0 ? numberOrNull(line.costUnitUsd) ?? numberOrNull(bomState.items.costUnitUsd) : numberOrNull(line.costUnitUsd);
    return value === null;
  });

  if (missingCostIndex >= 0) {
    const line = editableQuoteLines()[missingCostIndex];
    return `Costo unitario USD del item ${missingCostIndex + 1}${line.productName ? ` (${line.productName})` : ""}?`;
  }

  if (bomState.items.marginDivisor === null) return "Margen divisor general?";

  return "Hay mano de obra?";
}

function nextProviderPaymentQuestion() {
  const index = nextProviderPaymentIndex();
  const line = editableQuoteLines()[index] || {};
  return `Proveedor y condicion de pago del item ${index + 1}${line.productName ? ` (${line.productName})` : ""}?`;
}

function joinSpanishList(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} y ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

async function buildBomPreview() {
  const quote = (lastQuoteContext && lastQuoteContext.quote) || {};
  const products = editableQuoteLines();
  const product = products[0] || {};
  const exchange = await buildExchangeContext();
  const itemRows = buildMainItemRows(products, exchange);
  const associatedRows = buildAssociatedCostRows(exchange);
  const providers = buildProviderRows(products);
  const controls = buildControlRows();
  const negocio = buildBusinessRows(quote);
  const totals = calculateBomTotals(itemRows, associatedRows);

  const bomRows = [
    ["Cliente", quote.accountName || "", "Presupuesto", quote.quoteNumber || quote.id || "", "Asunto", quote.subject || "", "Fecha", todayIso()],
    ["TC billete venta", exchange.billSale || "Pendiente", "TC divisa venta", exchange.currencySale || "Pendiente", "Ratio billete/divisa", exchange.ratio || "Pendiente", "Fuente", exchange.source],
    exchange.warning ? ["Advertencia TC", exchange.warning] : [],
    [],
    ["COSTOS EN USD - ITEMS PRINCIPALES"],
    ["Item", "Producto", "Modelo / descripcion", "Cantidad", "Costo unit. USD", "Costo total USD", "Margen divisor", "PV unit. USD", "Total USD", "Dolar divisa", "Proveedor", "Condicion de pago"],
    ...itemRows.map((row) => row.cells),
    ["TOTAL ITEMS USD", money(totals.itemsUsd), money(totals.itemsDolarDivisa)],
    [],
    ["COSTOS ASOCIADOS"],
    ["Item", "Concepto", "Descripcion", "Cantidad", "Costo unit.", "Moneda", "Margen divisor", "PV unit.", "Subtotal", "Subtotal USD", "Notas"],
    ...associatedRows.map((row) => row.cells),
    ["TOTAL COSTOS USD", money(totals.associatedUsd)],
    [],
    ["TOTAL BOM USD", money(totals.totalUsd), "TOTAL DOLAR DIVISA", money(totals.totalDolarDivisa)],
    [],
    ["PROVEEDORES Y COTIZACIONES"],
    ["Proveedor", "Item / modelo", "Precio", "Moneda", "Condicion de pago", "Observaciones"],
    ...providers,
    [],
    ["PENDIENTES / CONTROL ADMINISTRATIVO"],
    ...controls,
  ];

  return {
    title: `${quote.accountName || "Cliente"} - ${quote.subject || "BOM"}`,
    tabs: {
      BOM: bomRows,
      Viaticos: buildLogisticsRows(),
      Materiales: buildMaterialsRows(),
      NEGOCIO: negocio,
    },
    totals,
    text: renderBomText({ BOM: bomRows, Viaticos: buildLogisticsRows(), Materiales: buildMaterialsRows(), NEGOCIO: negocio }),
  };
}

function firstQuoteProduct(quote) {
  return quoteProducts(quote)[0] || {};
}

function quoteProducts(quote) {
  return Array.isArray(quote.productDetails) && quote.productDetails.length ? quote.productDetails : [{}];
}

async function buildExchangeContext() {
  const bna = await getBnaExchangeContext();
  if (bna) return bna;

  const billSale = numberOrNull(bomState.exchange.billSale) || numberOrNull(process.env.TC_BILLETE_VENTA);
  const currencySale = numberOrNull(bomState.exchange.currencySale) || numberOrNull(process.env.TC_DIVISA_VENTA);
  const ratio = billSale && currencySale ? billSale / currencySale : null;

  if (!billSale || !currencySale) {
    throw new Error("No pude leer Banco Nacion. Carga manualmente TC billete venta y TC divisa venta en Datos para la BOM antes de generar.");
  }

  if (ratio < 1 || ratio > 1.5) {
    throw new Error(`El ratio TC billete/divisa debe quedar entre 1 y 1.5. Valor actual: ${ratio}`);
  }

  return {
    billSale,
    currencySale,
    ratio,
    source: bomState.exchange.billSale && bomState.exchange.currencySale ? "Manual usuario" : "Manual .env",
    warning: "No pude leer BNA Personas. Se usaron tipos de cambio manuales.",
  };
}

async function getBnaExchangeContext() {
  try {
    const html = await requestText(new URL("https://www.bna.com.ar/Personas"));
    const text = htmlToPlainText(html);
    const rates = extractBnaDollarRates(text);
    const billSale = rates.billSale;
    const currencySale = rates.currencySale;

    if (!billSale || !currencySale) return null;

    const ratio = billSale / currencySale;
    if (ratio < 1 || ratio > 1.5) {
      throw new Error(`Ratio BNA fuera de rango: ${ratio}`);
    }

    return {
      billSale,
      currencySale,
      ratio,
      source: "BNA Personas",
      warning: "",
    };
  } catch (error) {
    console.warn(`No pude obtener TC BNA: ${error.message}`);
    return null;
  }
}

function extractBnaDollarRates(text) {
  const rows = [];
  const pattern = /Dolar\s+U\.S\.A\s+([\d.,]+)\s+([\d.,]+)/gi;
  let match = null;

  while ((match = pattern.exec(text)) !== null) {
    rows.push({
      buy: parseBnaNumber(match[1]),
      sale: parseBnaNumber(match[2]),
    });
  }

  return {
    billSale: rows[0] ? rows[0].sale : null,
    currencySale: rows[1] ? rows[1].sale : null,
    rows,
  };
}

function parseBnaNumber(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  if (text.includes(",") && text.includes(".")) {
    return Number(text.replace(/\./g, "").replace(",", "."));
  }

  if (text.includes(",")) {
    return Number(text.replace(",", "."));
  }

  return Number(text);
}

function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMainItemRows(products, exchange) {
  const quoteItems = Array.isArray(products) && products.length ? products : [{}];
  const margin = numberOrNull(bomState.items.marginDivisor) || 1;

  return quoteItems.map((product, index) => {
    const quantity = index === 0 ? numberOrNull(bomState.items.quantity) || numberOrNull(product.quantity) || 1 : numberOrNull(product.quantity) || 1;
    const costUnit = index === 0 ? numberOrNull(product.costUnitUsd) || numberOrNull(bomState.items.costUnitUsd) || 0 : numberOrNull(product.costUnitUsd) || 0;
    const totalCost = quantity * costUnit;
    const pvUnit = safeDivide(costUnit, margin);
    const totalUsd = pvUnit * quantity;
    const dolarDivisa = exchange.ratio ? totalUsd * exchange.ratio : totalUsd;
    const provider = product.provider || (index === 0 ? bomState.items.provider : "") || "Pendiente";
    const paymentCondition = product.paymentCondition || (index === 0 ? bomState.items.paymentCondition : "") || "Pendiente";

    return {
      cells: [
        index + 1,
        index === 0 ? bomState.items.productName || product.productName || "" : product.productName || "",
        product.description || bomState.items.observations || "",
        quantity,
        money(costUnit),
        money(totalCost),
        margin,
        money(pvUnit),
        money(totalUsd),
        money(dolarDivisa),
        provider,
        paymentCondition,
      ],
      totalUsd,
      dolarDivisa,
    };
  });
}

function buildAssociatedCostRows(exchange) {
  const rows = [];
  let index = 1;
  const margin = numberOrNull(bomState.items.marginDivisor) || 1;

  if (bomState.labor.applies === true) {
    const hours = numberOrNull(bomState.labor.hours) || 0;
    const subtotalArs = hours * bomState.labor.hourlyRateArs;
    const pvArs = safeDivide(bomState.labor.hourlyRateArs, margin);
    const subtotalPvArs = pvArs * hours;
    const subtotalUsd = exchange.billSale ? subtotalPvArs / exchange.billSale : 0;

    rows.push({
      cells: [
        index++,
        "Mano de obra",
        bomState.labor.workType || "Pendiente de detalle",
        hours || "Pendiente",
        money(bomState.labor.hourlyRateArs),
        "ARS",
        margin,
        money(pvArs),
        money(subtotalPvArs || subtotalArs),
        money(subtotalUsd),
        "Valor hora hombre estandar",
      ],
      subtotalUsd,
    });

    const adminHours = numberOrNull(bomState.admin.managementDocumentationHours) || 1;
    const adminPvArs = safeDivide(bomState.labor.hourlyRateArs, margin) * adminHours;
    const adminUsd = exchange.billSale ? adminPvArs / exchange.billSale : 0;
    rows.push({
      cells: [
        index++,
        "Gestion ingreso y documentacion",
        "Gestion administrativa del servicio",
        adminHours,
        money(bomState.labor.hourlyRateArs),
        "ARS",
        margin,
        money(safeDivide(bomState.labor.hourlyRateArs, margin)),
        money(adminPvArs),
        money(adminUsd),
        "Incluido por mano de obra",
      ],
      subtotalUsd: adminUsd,
    });
  }

  if (bomState.insurance.applies === true) {
    const insuredValue = insuranceInsuredValueUsd();
    const rate = numberOrNull(bomState.insurance.rate) || 0;
    const subtotalUsd = insuredValue * rate;
    rows.push({
      cells: [
        index++,
        "Seguro",
        insuranceDescription(),
        rate || "Pendiente",
        money(insuredValue),
        "USD",
        1,
        money(subtotalUsd),
        money(subtotalUsd),
        money(subtotalUsd),
        insuredValue ? `Valor asegurado informado: USD ${money(insuredValue)}` : "Pendiente valor asegurado",
      ],
      subtotalUsd,
    });
  }

  const materialCost = bomState.materials.hasExtras === false ? 0 : numberOrNull(bomState.materials.cost) || 0;
  const materialSubtotalUsd = safeDivide(materialCost, margin);
  rows.push({
    cells: [
      index++,
      "Materiales extra",
      bomState.materials.hasExtras === false ? "Sin materiales extra" : bomState.materials.detail || "Pendiente de detalle",
      1,
      money(materialCost),
      "USD",
      margin,
      money(materialSubtotalUsd),
      money(materialSubtotalUsd),
      money(materialSubtotalUsd),
      bomState.materials.hasExtras === false ? "Informado por comercial" : "A confirmar",
    ],
    subtotalUsd: materialSubtotalUsd,
  });

  if (bomState.logistics.applies === true) {
    const km = numberOrNull(bomState.logistics.km) || 0;
    const baseCost = km * bomState.logistics.rateUsdPerKm + bomState.logistics.parkingUsd;
    const subtotalUsd = safeDivide(baseCost, margin);
    rows.push({
      cells: [
        index++,
        "Viaticos",
        logisticsDescription(km),
        1,
        money(baseCost),
        "USD",
        margin,
        money(subtotalUsd),
        money(subtotalUsd),
        money(subtotalUsd),
        "Segun datos informados por comercial",
      ],
      subtotalUsd,
    });
  }

  return rows;
}

function buildProviderRows(products) {
  const quoteItems = Array.isArray(products) && products.length ? products : [{}];
  return quoteItems.map((product, index) => [
    product.provider || (index === 0 ? bomState.items.provider : "") || "Pendiente",
    index === 0 ? bomState.items.productName || product.productName || "Item principal" : product.productName || "Item principal",
    money(index === 0 ? numberOrNull(product.costUnitUsd) || numberOrNull(bomState.items.costUnitUsd) || 0 : numberOrNull(product.costUnitUsd) || 0),
    "USD",
    product.paymentCondition || (index === 0 ? bomState.items.paymentCondition : "") || "Pendiente",
    bomState.items.observations || "Costo informado por comercial",
  ]);
}

function insuranceInsuredValueUsd() {
  if (bomState.insurance.type === "instalacion_nueva") {
    return mainItemsCostTotalUsd();
  }

  const value = numberOrNull(bomState.insurance.insuredValueUsd);
  if (!value) {
    throw new Error("Para intervencion, carga obligatoriamente el valor del equipo intervenido antes de generar la BOM.");
  }

  return value;
}

function mainItemsCostTotalUsd() {
  return editableQuoteLines().reduce((total, line, index) => {
    const quantity = index === 0 ? numberOrNull(bomState.items.quantity) || numberOrNull(line.quantity) || 1 : numberOrNull(line.quantity) || 1;
    const costUnit = index === 0 ? numberOrNull(line.costUnitUsd) || numberOrNull(bomState.items.costUnitUsd) || 0 : numberOrNull(line.costUnitUsd) || 0;
    return total + quantity * costUnit;
  }, 0);
}

function buildControlRows() {
  return [
    ["Items principales completos", bomState.items.confirmed || allMainItemDataPresent() ? "OK" : "Pendiente"],
    ["Mano de obra incluida", bomState.labor.applies === true ? `OK - ${bomState.labor.hours || "pendiente"} horas` : "No aplica"],
    ["Seguro incluido", "OK"],
    ["Gestion ingreso/documentacion", bomState.labor.applies === true ? "OK" : "No aplica"],
    ["Materiales extra", bomState.materials.hasExtras === null ? "Pendiente" : bomState.materials.hasExtras ? "OK - aplica" : "OK - no aplica"],
    ["Viaticos", bomState.logistics.applies === null ? "Pendiente" : bomState.logistics.applies ? `OK - ${bomState.logistics.km || "pendiente"} km` : "No aplica"],
    ["BOM asociado al presupuesto", "Pendiente de subir link/adjunto"],
  ];
}

function buildBusinessRows(quote) {
  const product = firstQuoteProduct(quote);
  return [
    ["Requerimiento / negocio"],
    [
      [
        quote.accountName ? `Cliente ${quote.accountName}.` : "",
        quote.subject ? `Presupuesto: ${quote.subject}.` : "",
        product.productName ? `Item principal: ${product.productName}.` : "",
        bomState.labor.workType ? `Trabajo: ${bomState.labor.workType}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    ],
  ];
}

function buildLogisticsRows() {
  const km = numberOrNull(bomState.logistics.km) || 0;
  const subtotal = bomState.logistics.applies === true ? km * bomState.logistics.rateUsdPerKm : 0;
  const total = bomState.logistics.applies === true ? subtotal + bomState.logistics.parkingUsd : 0;

  return [
    ["Item", "Descripcion", "Costo USD/km o unit.", "Cantidad km", "Estacionamiento USD", "Subtotal USD/km", "Incluye", "Total USD"],
    [1, bomState.logistics.destination || "Logistica informada por comercial", money(bomState.logistics.rateUsdPerKm), km, money(bomState.logistics.parkingUsd), money(subtotal), bomState.logistics.applies === true ? "Si" : "No", money(total)],
  ];
}

function buildMaterialsRows() {
  return [
    ["Item", "Descripcion", "Costo", "Moneda", "Notas"],
    [1, bomState.materials.hasExtras === false ? "Materiales extra" : bomState.materials.detail || "Materiales extra", money(numberOrNull(bomState.materials.cost) || 0), "USD", bomState.materials.hasExtras === false ? "No aplica" : "A confirmar"],
  ];
}

function calculateBomTotals(itemRows, associatedRows) {
  const itemsUsd = sum(itemRows.map((row) => row.totalUsd));
  const itemsDolarDivisa = sum(itemRows.map((row) => row.dolarDivisa));
  const associatedUsd = sum(associatedRows.map((row) => row.subtotalUsd));

  return {
    itemsUsd,
    itemsDolarDivisa,
    associatedUsd,
    totalUsd: itemsUsd + associatedUsd,
    totalDolarDivisa: itemsDolarDivisa + associatedUsd,
  };
}

function renderBomText(tabs) {
  return Object.entries(tabs)
    .map(([name, rows]) => {
      const lines = rows.map((row) => (Array.isArray(row) ? row.join(" | ") : String(row)));
      return `[${name}]\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function buildXlsxFile(tabs) {
  const sheetNames = Object.keys(tabs);
  const entries = [];

  entries.push({
    name: "[Content_Types].xml",
    data: xmlBuffer(buildContentTypesXml(sheetNames.length)),
  });
  entries.push({
    name: "_rels/.rels",
    data: xmlBuffer(buildRootRelsXml()),
  });
  entries.push({
    name: "xl/workbook.xml",
    data: xmlBuffer(buildWorkbookXml(sheetNames)),
  });
  entries.push({
    name: "xl/styles.xml",
    data: xmlBuffer(buildStylesXml()),
  });
  entries.push({
    name: "xl/_rels/workbook.xml.rels",
    data: xmlBuffer(buildWorkbookRelsXml(sheetNames.length)),
  });

  sheetNames.forEach((sheetName, index) => {
    entries.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: xmlBuffer(buildWorksheetXml(tabs[sheetName] || [], sheetName)),
    });
  });

  return buildZip(entries);
}

function buildContentTypesXml(sheetCount) {
  const sheets = [];
  for (let index = 1; index <= sheetCount; index += 1) {
    sheets.push(`<Override PartName="/xl/worksheets/sheet${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.join("\n")}
</Types>`;
}

function buildRootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function buildWorkbookXml(sheetNames) {
  const sheets = sheetNames
    .map((name, index) => `<sheet name="${escapeXml(xlsxSheetName(name))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets}</sheets>
</workbook>`;
}

function buildWorkbookRelsXml(sheetCount) {
  const relationships = [];
  for (let index = 1; index <= sheetCount; index += 1) {
    relationships.push(`<Relationship Id="rId${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index}.xml"/>`);
  }
  relationships.push(`<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships.join("\n")}
</Relationships>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="3">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="8">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF000000"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF404040"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFBFBFBF"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC00000"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="1" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
}

function buildWorksheetXml(rows, sheetName) {
  const preparedRows = prepareWorksheetRows(sheetName, rows);
  const options = worksheetOptions(sheetName, preparedRows);
  const sheetRows = preparedRows
    .map((row, rowIndex) => {
      const cells = (Array.isArray(row) ? row : [row])
        .map((value, columnIndex) => buildCellXml(value, columnIndex + 1, rowIndex + 1, styleForCell(sheetName, preparedRows, value, columnIndex + 1, rowIndex + 1)))
        .join("");
      const height = rowHeight(row);
      const heightAttrs = height ? ` ht="${height}" customHeight="1"` : "";
      return `<row r="${rowIndex + 1}"${heightAttrs}>${cells}</row>`;
    })
    .join("");
  const cols = buildColsXml(options.widths);
  const merges = buildMergeCellsXml(options.merges);
  const dimension = `<dimension ref="A1:${columnName(options.maxColumn)}${Math.max(preparedRows.length, 1)}"/>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${dimension}
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="24"/>
${cols}
<sheetData>${sheetRows}</sheetData>
${merges}
</worksheet>`;
}

function buildCellXml(value, column, row, styleId = 0) {
  const ref = `${columnName(column)}${row}`;
  const style = styleId ? ` s="${styleId}"` : "";
  if (isBlankCell(value) && !styleId) return "";

  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }

  const text = value === null || value === undefined ? "" : String(value);
  if (text.startsWith("=")) {
    return `<c r="${ref}"${style}><f>${escapeXml(text.slice(1))}</f></c>`;
  }

  const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"${style}><is><t${space}>${escapeXml(text)}</t></is></c>`;
}

function prepareWorksheetRows(sheetName, rows) {
  if (sheetName === "BOM") return prepareBomRows(rows);
  if (sheetName === "Viaticos") return prepareLogisticsSheetRows(rows);
  return rows.map((row) => (Array.isArray(row) ? row.slice() : [row]));
}

function prepareBomRows(rows) {
  const prepared = rows.map((row) => padRow(Array.isArray(row) ? row.slice() : [row], 12));
  if (prepared[0] && prepared[0][0] === "Cliente") {
    prepared[0] = padRow([prepared[0][0], prepared[0][1], "", prepared[0][2], prepared[0][3], "", prepared[0][4], prepared[0][5], "", prepared[0][6], prepared[0][7]], 12);
  }
  if (prepared[1] && prepared[1][0] === "TC billete venta") {
    prepared[1] = padRow([prepared[1][0], prepared[1][1], "", prepared[1][2], prepared[1][3], "", prepared[1][4], prepared[1][5], "", prepared[1][6], prepared[1][7]], 12);
  }

  const firstSectionIndex = prepared.findIndex((row) => isSectionTitle(row[0]));
  if (firstSectionIndex > 2 && isEmptyRow(prepared[firstSectionIndex - 1])) {
    prepared.splice(firstSectionIndex - 1, 1);
  }

  const mainHeaderIndex = prepared.findIndex((row) => row[0] === "Item" && row[1] === "Producto");
  const totalItemsIndex = prepared.findIndex((row) => row[0] === "TOTAL ITEMS USD");
  if (mainHeaderIndex >= 0 && totalItemsIndex > mainHeaderIndex) {
    for (let index = mainHeaderIndex + 1; index < totalItemsIndex; index += 1) {
      if (isEmptyRow(prepared[index])) continue;
      const excelRow = index + 1;
      prepared[index][5] = `=D${excelRow}*E${excelRow}`;
      prepared[index][7] = `=E${excelRow}/G${excelRow}`;
      prepared[index][8] = `=H${excelRow}*D${excelRow}`;
      prepared[index][9] = `=I${excelRow}*$H$2`;
    }
    const firstDataRow = mainHeaderIndex + 2;
    const lastDataRow = totalItemsIndex;
    prepared[totalItemsIndex] = padRow(["", "", "", "", "", "", "", "TOTAL ITEMS USD", `=SUM(I${firstDataRow}:I${lastDataRow})`, `=SUM(J${firstDataRow}:J${lastDataRow})`], 12);
  }

  const associatedHeaderIndex = prepared.findIndex((row) => row[0] === "Item" && row[1] === "Concepto");
  const totalCostsIndex = prepared.findIndex((row) => row[0] === "TOTAL COSTOS USD");
  if (associatedHeaderIndex >= 0 && totalCostsIndex > associatedHeaderIndex) {
    for (let index = associatedHeaderIndex + 1; index < totalCostsIndex; index += 1) {
      if (isEmptyRow(prepared[index])) continue;
      const excelRow = index + 1;
      const concept = String(prepared[index][1] || "");
      const currency = String(prepared[index][5] || "");
      if (concept === "Viaticos") prepared[index][4] = "=Viaticos!H2";
      if (currency === "ARS") {
        prepared[index][7] = `=E${excelRow}/G${excelRow}`;
        prepared[index][8] = `=H${excelRow}*D${excelRow}`;
        prepared[index][9] = `=I${excelRow}/$B$2`;
      } else if (concept === "Seguro") {
        prepared[index][7] = `=E${excelRow}*D${excelRow}/G${excelRow}`;
        prepared[index][8] = `=H${excelRow}`;
        prepared[index][9] = `=I${excelRow}`;
      } else {
        prepared[index][7] = `=E${excelRow}/G${excelRow}`;
        prepared[index][8] = `=H${excelRow}*D${excelRow}`;
        prepared[index][9] = `=I${excelRow}`;
      }
    }
    const firstDataRow = associatedHeaderIndex + 2;
    const lastDataRow = totalCostsIndex;
    prepared[totalCostsIndex] = padRow(["", "", "", "", "", "", "", "TOTAL COSTOS USD", "", `=SUM(J${firstDataRow}:J${lastDataRow})`], 12);
  }

  const totalBomIndex = prepared.findIndex((row) => row[0] === "TOTAL BOM USD");
  if (totalBomIndex >= 0 && totalItemsIndex >= 0 && totalCostsIndex >= 0) {
    prepared[totalBomIndex] = padRow(["", "", "", "", "", "", "", "TOTAL BOM USD", `=I${totalItemsIndex + 1}+J${totalCostsIndex + 1}`, "TOTAL DOLAR DIVISA", `=J${totalItemsIndex + 1}+J${totalCostsIndex + 1}*$H$2`], 12);
  }

  return prepared;
}

function prepareLogisticsSheetRows(rows) {
  const prepared = rows.map((row) => (Array.isArray(row) ? row.slice() : [row]));
  if (prepared[1]) {
    prepared[1][5] = "=C2*D2";
    prepared[1][7] = "=F2+E2";
  }
  return prepared;
}

function worksheetOptions(sheetName, rows) {
  if (sheetName === "BOM") {
    return {
      maxColumn: 12,
      widths: [37, 38, 45, 17, 19, 42, 22, 23, 13, 20, 39, 25],
      merges: rows
        .map((row, index) => (isSectionTitle(row[0]) ? `A${index + 1}:L${index + 1}` : null))
        .filter(Boolean),
    };
  }

  if (sheetName === "Viaticos") {
    return { maxColumn: 8, widths: [12, 45, 22, 13, 21, 17, 12, 16], merges: [] };
  }

  if (sheetName === "Materiales") {
    return { maxColumn: 5, widths: [12, 28, 12, 12, 38], merges: [] };
  }

  if (sheetName === "NEGOCIO") {
    return { maxColumn: 1, widths: [90], merges: [] };
  }

  return { maxColumn: Math.max(1, ...rows.map((row) => row.length)), widths: [], merges: [] };
}

function buildColsXml(widths) {
  if (!Array.isArray(widths) || !widths.length) return "";
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  return `<cols>${cols}</cols>`;
}

function buildMergeCellsXml(merges) {
  if (!Array.isArray(merges) || !merges.length) return "";
  return `<mergeCells count="${merges.length}">${merges.map((range) => `<mergeCell ref="${range}"/>`).join("")}</mergeCells>`;
}

function styleForCell(sheetName, rows, value, column, rowNumber) {
  const row = rows[rowNumber - 1] || [];
  if (isBlankCell(value) && !isSectionTitle(row[0])) return 0;
  if (isToConfirmCell(value)) return 11;
  if (isSectionTitle(row[0])) return 3;
  if (isHeaderRow(sheetName, row, rowNumber)) return 4;
  if (sheetName === "BOM" && (rowNumber === 1 || rowNumber === 2 || String(row[0] || "").startsWith("Advertencia"))) {
    return typeof value === "number" || isFormula(value) ? 2 : 1;
  }
  if (isTotalRow(row)) return typeof value === "number" || isFormula(value) ? 9 : 8;
  if (isFormula(value)) return 7;
  if (typeof value === "number" && Number.isFinite(value)) return 6;
  if (sheetName === "NEGOCIO" && rowNumber === 1) return 10;
  return 5;
}

function isHeaderRow(sheetName, row, rowNumber) {
  if ((sheetName === "Viaticos" || sheetName === "Materiales") && rowNumber === 1) return true;
  if (row[0] === "Item" && (row[1] === "Producto" || row[1] === "Concepto" || row[1] === "Descripcion")) return true;
  return row[0] === "Proveedor" && row[1] === "Item / modelo";
}

function isTotalRow(row) {
  return row.some((cell) => String(cell || "").startsWith("TOTAL "));
}

function isSectionTitle(value) {
  return [
    "COSTOS EN USD - ITEMS PRINCIPALES",
    "COSTOS ASOCIADOS",
    "PROVEEDORES Y COTIZACIONES",
    "PENDIENTES / CONTROL ADMINISTRATIVO",
  ].includes(String(value || ""));
}

function rowHeight(row) {
  if (row.some((cell) => String(cell || "").length > 65)) return 39.75;
  return 24;
}

function isFormula(value) {
  return typeof value === "string" && value.startsWith("=");
}

function isToConfirmCell(value) {
  return normalizeForStage(value).includes("a confirmar");
}

function isBlankCell(value) {
  return value === null || value === undefined || value === "";
}

function isEmptyRow(row) {
  return !row.some((cell) => !isBlankCell(cell));
}

function padRow(row, length) {
  const copy = row.slice();
  while (copy.length < length) copy.push("");
  return copy;
}

function columnName(index) {
  let name = "";
  let current = index;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function xlsxSheetName(name) {
  return String(name || "Hoja")
    .replace(/[\[\]:*?/\\]/g, " ")
    .trim()
    .slice(0, 31) || "Hoja";
}

function xmlBuffer(value) {
  return Buffer.from(String(value), "utf8");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function allMainItemDataPresent() {
  return allMainItemCostsPresent() && bomState.items.marginDivisor !== null;
}

function insuranceDescription() {
  if (bomState.insurance.type === "instalacion_nueva") return "Instalacion nueva";
  if (bomState.insurance.type === "intervencion_equipo_cliente") return "Intervencion sobre equipo del cliente";
  return "Instalacion nueva";
}

function logisticsDescription(km) {
  const destination = bomState.logistics.destination ? ` a ${bomState.logistics.destination}` : "";
  return km ? `Servicio${destination} - ${km} km` : `Servicio${destination}`;
}

function money(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return Number(number.toFixed(2));
}

function safeDivide(value, divisor) {
  const number = Number(value || 0);
  const div = Number(divisor || 0);
  if (!div) return 0;
  return number / div;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowIso(daysFromToday) {
  const date = new Date();
  date.setDate(date.getDate() + Number(daysFromToday || 1));
  return date.toISOString().slice(0, 10);
}

function lastAssistantMessage() {
  for (let index = chatHistory.length - 1; index >= 0; index -= 1) {
    if (chatHistory[index].role === "assistant") return chatHistory[index].content || "";
  }

  return "";
}

function normalizeForStage(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1.$2")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function buildSafeQuoteContext(context) {
  if (!context) return null;

  const quote = context.quote || {};
  const products = Array.isArray(quote.productDetails) ? quote.productDetails : [];

  return {
    quote: {
      hasQuoteLoaded: true,
      subjectType: quote.subject && /prueba/i.test(quote.subject) ? "presupuesto de prueba" : "presupuesto",
      status: quote.status || "",
      costsIsEmpty: !quote.costs,
      currency: quote.currency || "",
      grandTotalIsZero: Number(quote.grandTotal || 0) === 0,
      productDetails: products.map((item) => ({
        productName: item.productName || "",
        productCode: item.productCode || "",
        productId: item.productId || "",
        description: item.description || "",
        quantity: item.quantity,
        listPrice: item.listPrice,
        total: item.total,
        netTotal: item.netTotal,
        productStock: item.productStock,
        productUnitPrice: item.productUnitPrice,
        listPriceIsZero: Number(item.listPrice || 0) === 0,
      })),
    },
    bomAnalysis: context.bomAnalysis
      ? {
          readyForBom: context.bomAnalysis.readyForBom,
          warnings: context.bomAnalysis.warnings || [],
          nextAction: context.bomAnalysis.nextAction || "",
        }
      : null,
  };
}

function buildSafeBomStateForAgent() {
  return {
    readyForBom: bomState.readyForBom || false,
    items: Object.assign({}, bomState.items),
    labor: {
      applies: bomState.labor.applies,
      hours: bomState.labor.hours,
      workType: bomState.labor.workType,
    },
    admin: {
      appliesWhenLaborApplies: bomState.labor.applies === true,
    },
    insurance: {
      applies: bomState.insurance.applies,
      type: bomState.insurance.type,
      insuredValueUsd: bomState.insurance.insuredValueUsd,
      confirmed: bomState.insurance.confirmed === true,
    },
    materials: Object.assign({}, bomState.materials),
    logistics: {
      applies: bomState.logistics.applies,
      km: bomState.logistics.km,
      destination: bomState.logistics.destination,
    },
  };
}

function buildEditableBomState() {
  normalizeInsuranceDefaults();
  return {
    readyForBom: bomState.readyForBom || false,
    items: Object.assign({}, bomState.items),
    labor: {
      applies: bomState.labor.applies,
      hours: bomState.labor.hours,
      workType: bomState.labor.workType,
      hourlyRateArs: bomState.labor.hourlyRateArs,
    },
    admin: Object.assign({}, bomState.admin),
    insurance: {
      applies: bomState.insurance.applies,
      type: bomState.insurance.type,
      insuredValueUsd: bomState.insurance.insuredValueUsd,
      rate: bomState.insurance.rate,
      confirmed: bomState.insurance.confirmed === true,
    },
    materials: Object.assign({}, bomState.materials),
    logistics: {
      applies: bomState.logistics.applies,
      km: bomState.logistics.km,
      destination: bomState.logistics.destination,
      rateUsdPerKm: bomState.logistics.rateUsdPerKm,
      parkingUsd: bomState.logistics.parkingUsd,
    },
    exchange: {
      billSale: bomState.exchange.billSale,
      currencySale: bomState.exchange.currencySale,
    },
  };
}

function openAiResponse(payload) {
  const body = JSON.stringify(payload);
  const apiUrl = new URL("https://api.openai.com/v1/responses");

  return requestJson(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
}

function extractOpenAiText(response) {
  if (response.output_text) return response.output_text;

  const chunks = [];
  for (const item of response.output || []) {
    for (const part of item.content || []) {
      if (part.text) chunks.push(part.text);
    }
  }

  return chunks.join("\n").trim() || "No pude generar una respuesta.";
}

function cleanAgentAnswer(answer) {
  return String(answer || "")
    .replace(/\*\*/g, "")
    .replace(/1%|3%|0\.71\s*USD\/km|20\s*USD|Juan Pablo Duarte 4728,?\s*CABA,?\s*Argentina/gi, "")
    .replace(/minimo\s+1\s+hora|mínimo\s+1\s+hora/gi, "gestion/documentacion")
    .replace(/^\s*(entendido|perfecto|ok|recibido|de acuerdo)\s*[:.,-]?\s*/i, "")
    .replace(/^\s*(entendido|perfecto|ok|recibido|de acuerdo)\s*[:.,-]?\s*/i, "")
    .trim();
}

function trimChatHistory() {
  if (chatHistory.length > 12) {
    chatHistory.splice(0, chatHistory.length - 12);
  }
}

function summarizeProducts(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const product = firstPresent(item.product, item.Product_Name, item.Product, item.Product_Details);
    return {
      lineId: firstPresent(item.id, item.ID, ""),
      sequence: firstPresent(item.Sequence_Number, item.sequence_number, index + 1),
      productId: lookupId(product),
      productName: lookupName(product) || firstPresent(item.Product_Name, item.product_name, item.Name, ""),
      productCode: firstPresent(product && product.Product_Code, item.Product_Code, item.product_code, ""),
      description: firstPresent(item.product_description, item.Description, item.description, ""),
      quantity: numberOrNull(firstPresent(item.quantity, item.Quantity, item.Qty, item.qty)) || 0,
      listPrice: numberOrNull(firstPresent(item.list_price, item.List_Price, item.Unit_Price, item.unit_price)) || 0,
      total: numberOrNull(firstPresent(item.total, item.Total, item.Total_After_Discount, item.total_after_discount)) || 0,
      netTotal: numberOrNull(firstPresent(item.net_total, item.Net_Total, item.Grand_Total)) || 0,
      discount: numberOrNull(firstPresent(item.discount, item.Discount)) || 0,
      tax: numberOrNull(firstPresent(item.tax, item.Tax)) || 0,
      productUnitPrice: numberOrNull(firstPresent(product && product.Unit_Price, item.Unit_Price)) || 0,
      productStock: numberOrNull(firstPresent(product && product.Qty_in_Stock, item.Qty_in_Stock, item.Stock)),
      productQtyOrdered: numberOrNull(firstPresent(product && product.Qty_Ordered, item.Qty_Ordered)),
    };
  });
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function lookupName(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.name || value.Name || "";
}

function lookupId(value) {
  if (!value || typeof value === "string") return "";
  return value.id || value.ID || "";
}

function requestJson(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: options.method,
        headers: options.headers,
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (response.statusCode >= 400) {
              reject(new Error(errorMessage(parsed, response.statusCode)));
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Respuesta no valida: ${raw}`));
          }
        });
      }
    );

    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function requestText(url) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "Bessel BOM Assistant",
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          resolve(raw);
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}

function errorMessage(parsed, statusCode) {
  if (parsed && parsed.error) {
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error.message) return parsed.error.message;
    return JSON.stringify(parsed.error);
  }

  if (parsed && parsed.message) return parsed.message;
  return `HTTP ${statusCode}`;
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    return sendError(res, 403, "Ruta no permitida.");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) return sendError(res, 404, "No encontrado.");
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function sendJson(res, data) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function sendDownloadJson(res, filename, data) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendDownloadBuffer(res, filename, buffer, contentTypeValue) {
  res.writeHead(200, {
    "Content-Type": contentTypeValue,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": buffer.length,
  });
  res.end(buffer);
}

function sendError(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const dataBuffer = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(dataBuffer);
    const localHeader = buildZipLocalHeader(nameBuffer, dataBuffer, crc);
    const centralHeader = buildZipCentralHeader(nameBuffer, dataBuffer, crc, offset);

    localParts.push(localHeader, dataBuffer);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBuffer.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = buildZipEndRecord(entries.length, centralDirectory.length, offset);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function buildZipLocalHeader(nameBuffer, dataBuffer, crc) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(dataBuffer.length, 18);
  header.writeUInt32LE(dataBuffer.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuffer]);
}

function buildZipCentralHeader(nameBuffer, dataBuffer, crc, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(dataBuffer.length, 20);
  header.writeUInt32LE(dataBuffer.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBuffer]);
}

function buildZipEndRecord(entryCount, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crc32Table()[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let cachedCrc32Table = null;
function crc32Table() {
  if (cachedCrc32Table) return cachedCrc32Table;

  cachedCrc32Table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    cachedCrc32Table[index] = value >>> 0;
  }
  return cachedCrc32Table;
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function callbackPage(title, message, sessionKey) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="shell">
    <section class="panel narrow">
      <p class="eyebrow">Zoho OAuth</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${sessionKey ? `<p class="muted">Sesion local: ${escapeHtml(sessionKey)}</p>` : ""}
      <a class="button" href="/">Volver al inicio</a>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
