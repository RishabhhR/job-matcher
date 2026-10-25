# Production deployment policy

- GitHub `main` is the source of truth for code and version history.
- Vercel Git auto-deployments are disabled. A push or merge alone must not change production.
- Production deployment is deliberate: use the `Manual production deployment` GitHub Actions workflow, select `main`, and type `DEPLOY`; or use the authenticated Vercel CLI only after the user explicitly requests a production deployment.
- Do not run `vercel --prod`, promote a deployment, create a deploy hook, or trigger the production workflow as routine verification. Ask for a clear user request if deployment is not part of the current instruction.
- Do not run load tests against production. Use localhost or an explicitly authorized staging target.
- Deployment retention is configured to one day for canceled, errored, pre-production, and production deployments. Active production deployments are retained by Vercel; older rollback artifacts may be removed, so recover older releases from GitHub and redeploy only when authorized.

The GitHub workflow requires the `VERCEL_TOKEN` Actions secret. It fails before build/deploy when that secret is absent. Never print the token in logs or commit it to the repository.
