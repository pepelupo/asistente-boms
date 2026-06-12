# Asistente para BOMs - prototipo local

Este prototipo sirve para probar la conexion OAuth con Zoho.

## Archivos importantes

- `.env.example`: ejemplo de configuracion.
- `.env`: configuracion privada real. No compartir.
- `server.js`: servidor local.
- `public/`: pantalla web.

## Como configurar

1. Copiar `.env.example` como `.env`.
2. Completar:
   - `ZOHO_CLIENT_ID`
   - `ZOHO_CLIENT_SECRET`
   - `ZOHO_REDIRECT_URI`
3. En Zoho API Console, verificar que la Redirect URI coincida exactamente con:

   `http://localhost:3000/api/auth/zoho/callback`

4. Ejecutar:

   `node server.js`

5. Abrir:

   `http://localhost:3000`

## Login local

Si todavia no existe `usuarios.json`, el servidor crea un administrador inicial:

- Usuario: `ignacio.vidalbruni`
- Contraseña: `Cambiar123!`

Para cambiar esa contraseña inicial antes de crear el usuario, definir `INITIAL_ADMIN_PASSWORD` en `.env`.
