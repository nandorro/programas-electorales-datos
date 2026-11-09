# Programas Electorales (web)

Compara las propuestas de los partidos en las elecciones generales de España (29-nov-2026).

**Web:** https://nandorro.github.io/programas-electorales-datos/

- **iPhone:** abre el enlace en Safari → botón Compartir → *Añadir a pantalla de inicio*.
- **Android:** abre el enlace en Chrome → menú → *Instalar aplicación* (o usa el APK).
- Funciona sin conexión una vez abierta.

## Cómo se actualiza
- `data.json`: respuestas, orden por encuestas, enlaces. Súbele el número de `version` para que los móviles lo recojan.
- `programas/<PARTIDO>.json`: texto de cada programa oficial, extraído por `buscar-programas.js`
  (busca el PDF en la web del partido, detecta cambios y lo procesa). Se ejecuta con
  `node buscar-programas.js` (requiere `npm i`) o automáticamente con la acción programada.

Los resúmenes marcados «Resumen provisional» son orientativos; los de «Programa oficial» citan el PDF con su página.
