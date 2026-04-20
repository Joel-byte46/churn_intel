// _shared/config.ts

export const MODELS = {
  // Analyse et diagnostic — meilleur reasoning
  // Utilisé dans : analyze/, benchmark-compare/
  ANALYSIS: 'claude-sonnet-4-5',

  // Génération email — bon output, moins cher
  // Utilisé dans : report/, benchmark-report/, autopilot-intervene/
  NARRATIVE: 'claude-sonnet-4-5',

  // Tâches légères — digest court, lecture benchmark simple
  // Utilisé dans : autopilot-deploy/ (digest founder)
  FAST: 'claude-sonnet-4-5',
} as const

export type ModelKey = keyof typeof MODELS

// Si le founder a configuré un modèle préféré dans son profil,
// on l'utilise à la place du défaut système
export function resolveModel(
  key: ModelKey,
  founderPreference?: string | null
): string {
  if (founderPreference && isValidModel(founderPreference)) {
    return founderPreference
  }
  return MODELS[key]
}

// Modèles acceptés — mis à jour ici uniquement
const VALID_MODELS = [
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-3-5-sonnet-20241022', // fallback legacy
] as const

export type ValidModel = typeof VALID_MODELS[number]

function isValidModel(model: string): model is ValidModel {
  return VALID_MODELS.includes(model as ValidModel)
}
