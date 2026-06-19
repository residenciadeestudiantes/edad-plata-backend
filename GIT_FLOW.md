# Flujo de ramas

Este repo sigue el modelo git-flow, sin la extensión CLI (solo convención de nombres):

- `main` — siempre desplegable. Cada commit en `main` es una versión publicada.
- `develop` — rama de integración. Todo el trabajo nuevo parte de aquí.
- `feature/<nombre>` — una funcionalidad. Sale de `develop`, vuelve a `develop` (merge o PR).
- `release/<version>` — preparación de una versión. Sale de `develop`, al cerrarse se mergea en `main` y en `develop`, y se etiqueta (`vX.Y.Z`) en `main`.
- `hotfix/<nombre>` — corrección urgente sobre producción. Sale de `main`, se mergea en `main` y en `develop`, y se etiqueta en `main`.

Ejemplo:

```bash
git checkout develop
git checkout -b feature/visor-pdf
# ... commits ...
git checkout develop
git merge feature/visor-pdf
git branch -d feature/visor-pdf
```
