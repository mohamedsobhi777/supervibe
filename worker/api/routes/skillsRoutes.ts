/**
 * Custom Agent Skills Routes
 * Routes for user skill management
 */
import { Hono } from 'hono';
import { AppEnv } from '../../types/appenv';
import { SkillsController } from '../controllers/skills/controller';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';
import { adaptController } from '../honoAdapter';

export function setupSkillsRoutes(app: Hono<AppEnv>): void {
    // Custom agent skill routes
    app.get('/api/user/skills', setAuthLevel(AuthConfig.authenticated), adaptController(SkillsController, SkillsController.getSkills));
    app.post('/api/user/skills', setAuthLevel(AuthConfig.authenticated), adaptController(SkillsController, SkillsController.createSkill));
    app.put('/api/user/skills/:id', setAuthLevel(AuthConfig.authenticated), adaptController(SkillsController, SkillsController.updateSkill));
    app.delete('/api/user/skills/:id', setAuthLevel(AuthConfig.authenticated), adaptController(SkillsController, SkillsController.deleteSkill));
}
