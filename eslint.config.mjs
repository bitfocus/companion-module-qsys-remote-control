import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({})

const customConfig = [
	...baseConfig,
	{
		languageOptions: {
			sourceType: 'module',
		},
	},
	{
		// Tests and their config import devDependencies, and are never packaged
		files: ['**/*.spec.js', 'vitest.config.js'],
		rules: {
			'n/no-unpublished-import': 'off',
		},
	},
]

export default customConfig
