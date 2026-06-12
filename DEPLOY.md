# Publicar el Asistente para BOMs

Esta guia resume lo necesario para llevar el MVP local a una URL publica.

## Estado actual

La app ya puede correr como servidor Node.js con:

```bash
npm start
```

Tambien expone un chequeo simple de salud:

```text
/api/health
```

## Recomendacion para el primer live

Para el primer despliegue conviene usar:

- Hosting simple para Node.js: Render.
- Base de datos gratuita: Neon Postgres.
- Dominio/subdominio: `asistente-boms.bessel.com.ar`.
- HTTPS automatico del proveedor.
- No hace falta disco persistente si se configura `DATABASE_URL`.

## Variables necesarias

En el panel del hosting hay que cargar estas variables:

```text
DATABASE_URL=postgresql://...

ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REDIRECT_URI=https://asistente-boms.bessel.com.ar/api/auth/zoho/callback
ZOHO_ACCOUNTS_BASE=https://accounts.zoho.com
ZOHO_CRM_BASE=https://www.zohoapis.com/crm/v8
ZOHO_SCOPES=ZohoCRM.modules.ALL,ZohoCRM.settings.READ

OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.2

ZIA_TOOL_SECRET=...
PUBLIC_BASE_URL=https://asistente-boms.bessel.com.ar

INITIAL_ADMIN_USERNAME=ignacio.vidalbruni@bessel.com.ar
INITIAL_ADMIN_PASSWORD=...
INITIAL_ADMIN_NAME=Juan Ignacio Vidal Bruni
INITIAL_ADMIN_EMAIL=ignacio.vidalbruni@bessel.com.ar
INITIAL_COMMERCIAL_USERNAME=german.planes@bessel.com.ar
INITIAL_COMMERCIAL_PASSWORD=123456
INITIAL_COMMERCIAL_NAME=German Planes
INITIAL_COMMERCIAL_EMAIL=german.planes@bessel.com.ar
ADMIN_USERS=ignacio.vidalbruni@bessel.com.ar
USER_MANAGER_USERS=ignacio.vidalbruni@bessel.com.ar

TC_BILLETE_VENTA=
TC_DIVISA_VENTA=
```

No cargar `PORT` manualmente en Render. Render lo define solo y la app ya lo usa automaticamente.

## Configuracion en Render

En el formulario de Render:

```text
Language: Node
Branch: main
Build Command: npm install
Start Command: npm start
```

Si el repositorio de GitHub contiene directamente `server.js` y `package.json`, dejar `Root Directory` vacio.

Si el repositorio contiene toda esta carpeta de Codex y la app esta dentro de `work/asistente-boms`, usar:

```text
Root Directory: work/asistente-boms
```

## Cambios en Zoho

En Zoho API Console, agregar como Redirect URI:

```text
https://asistente-boms.bessel.com.ar/api/auth/zoho/callback
```

Debe coincidir exactamente con `ZOHO_REDIRECT_URI`.

## Datos persistentes

Si `DATABASE_URL` esta configurado, la app guarda datos operativos en Neon Postgres:

- Usuarios de la app.
- Token OAuth de Zoho.
- Estado temporal de BOM.
- Prompt actual.
- Archivos de contexto del bot.

Si `DATABASE_URL` no esta configurado, la app vuelve al modo local con archivos.

## Login

Si no existen usuarios, la app crea un primer administrador con:

```text
INITIAL_ADMIN_USERNAME
INITIAL_ADMIN_PASSWORD
INITIAL_ADMIN_NAME
INITIAL_ADMIN_EMAIL
```

Tambien puede crear un comercial inicial con:

```text
INITIAL_COMMERCIAL_USERNAME
INITIAL_COMMERCIAL_PASSWORD
INITIAL_COMMERCIAL_NAME
INITIAL_COMMERCIAL_EMAIL
```

La contraseña se guarda hasheada, no como texto plano.

Para el primer deploy, definir `INITIAL_ADMIN_PASSWORD` con una contraseña segura antes del primer arranque.

Roles disponibles:

```text
admin
gerente_comercial
comercial
```

La seccion de administracion de usuarios solo queda disponible para los usuarios listados en `USER_MANAGER_USERS`.

## Limitacion importante del MVP

El MVP ya tiene login propio, pero todavia trabaja con un estado compartido de BOM y una conexion Zoho compartida.

Para abrirlo a varios comerciales en simultaneo, el siguiente bloque debe ser:

1. Login real por usuario.
2. Token de Zoho separado por usuario.
3. Estado de BOM separado por usuario o por presupuesto.
4. Roles persistentes: administrador y comercial.

## Prueba de salida a produccion

Antes de habilitarlo al equipo:

1. Abrir `/api/health`.
2. Entrar a la app.
3. Conectar Zoho.
4. Leer un presupuesto falso.
5. Completar datos con el chat.
6. Generar `.xlsx`.
7. Subir BOM a Zoho.
8. Probar usuario administrador.
9. Probar usuario comercial.
