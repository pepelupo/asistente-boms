# Custom Tools para Zia Agents

Vamos a usar Zia Agents solo como interfaz conversacional con BYOK OpenAI.

No usaremos System Tools de Zia. Todas las acciones operativas pasan por nuestra API.

## Archivo OpenAPI

Subir este archivo en Zia Agents:

```text
zia-tools/bessel-bom-tools.openapi.yaml
```

Antes de subirlo en produccion, revisar la URL dentro de `servers`:

```yaml
servers:
  - url: https://asistente-boms.bessel.com.ar
```

Debe ser la URL publica real donde este desplegado nuestro backend.

## Seguridad

Todas las custom tools usan:

```text
Authorization: Bearer <ZIA_TOOL_SECRET>
```

En el servidor, configurar:

```text
ZIA_TOOL_SECRET=un_token_largo_y_privado
```

En Zia Agents, al crear o asociar la connection/custom service, usar ese mismo token.

## Tools incluidas

1. `pingBesselBomTools`
   - Verifica que Zia puede llamar nuestra API.

2. `readZohoQuoteForBom`
   - Lee un presupuesto de Zoho CRM y devuelve datos normalizados.

3. `searchZohoProductsForBom`
   - Busca productos en Zoho CRM.

4. `readBnaExchangeForBom`
   - Lee cotizaciones BNA para BOM.

5. `updateZohoQuoteFieldsForBom`
   - Actualiza campos permitidos del presupuesto.
   - Campos permitidos inicialmente:
     - `Costos`
     - `Description`
     - `Terms_and_Conditions`
     - `Quote_Stage`
     - `Valid_Till`
     - `Subject`

6. `generateAndAttachBomToZohoQuote`
   - Genera XLSX, lo adjunta al presupuesto y actualiza `Costos = adjunto`.

## Orden de prueba recomendado

1. Subir YAML.
2. Validar schema.
3. Asociar connection con bearer token.
4. Probar `pingBesselBomTools`.
5. Probar `readZohoQuoteForBom` con un presupuesto falso.
6. Probar `searchZohoProductsForBom`.
7. Probar `readBnaExchangeForBom`.
8. Probar `updateZohoQuoteFieldsForBom` con `Costos = prueba`.
9. Recien al final probar `generateAndAttachBomToZohoQuote`.

## Nota importante

Estas tools requieren que el backend tenga conexion valida con Zoho.

En el MVP, eso significa que primero hay que conectar Zoho desde la app web al menos una vez para guardar el refresh token.

Para reducir errores de validacion en Zia, las tools iniciales piden `quoteId` como dato obligatorio. El agente puede extraerlo del link del presupuesto o pedirlo al usuario.
