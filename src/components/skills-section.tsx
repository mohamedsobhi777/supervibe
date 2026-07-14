import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api-client';
import {
	SKILL_NAME_REGEX,
	MAX_SKILL_DESCRIPTION_LENGTH,
	MAX_SKILL_CONTENT_LENGTH,
} from '@/api-types';
import type { AgentSkill } from '@/api-types';

interface SkillFormData {
	name: string;
	description: string;
	content: string;
}

const EMPTY_FORM: SkillFormData = { name: '', description: '', content: '' };

function validateForm(form: SkillFormData): string | null {
	if (!SKILL_NAME_REGEX.test(form.name)) {
		return 'Name must be 1-64 characters: letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit';
	}
	if (!form.description.trim() || form.description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
		return `Description is required (max ${MAX_SKILL_DESCRIPTION_LENGTH} characters)`;
	}
	if (!form.content.trim() || form.content.length > MAX_SKILL_CONTENT_LENGTH) {
		return `Instructions are required (max ${MAX_SKILL_CONTENT_LENGTH.toLocaleString()} characters)`;
	}
	return null;
}

export function SkillsSection() {
	const [skills, setSkills] = useState<AgentSkill[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editingSkill, setEditingSkill] = useState<AgentSkill | null>(null);
	const [formData, setFormData] = useState<SkillFormData>(EMPTY_FORM);
	const [deleteTarget, setDeleteTarget] = useState<AgentSkill | null>(null);

	const loadSkills = useCallback(async () => {
		try {
			setLoading(true);
			const response = await apiClient.getSkills();
			if (response.success && response.data) {
				setSkills(response.data.skills);
			} else {
				throw new Error(response.error?.message || 'Failed to load skills');
			}
		} catch (error) {
			console.error('Error loading skills:', error);
			toast.error('Failed to load skills');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadSkills();
	}, [loadSkills]);

	const openCreate = () => {
		setEditingSkill(null);
		setFormData(EMPTY_FORM);
		setEditorOpen(true);
	};

	const openEdit = (skill: AgentSkill) => {
		setEditingSkill(skill);
		setFormData({
			name: skill.name,
			description: skill.description,
			content: skill.content,
		});
		setEditorOpen(true);
	};

	const handleSave = async () => {
		const validationError = validateForm(formData);
		if (validationError) {
			toast.error(validationError);
			return;
		}

		try {
			setSaving(true);
			const response = editingSkill
				? await apiClient.updateSkill(editingSkill.id, formData)
				: await apiClient.createSkill(formData);

			if (response.success) {
				toast.success(editingSkill ? 'Skill updated' : 'Skill created');
				setEditorOpen(false);
				await loadSkills();
			} else {
				throw new Error(response.error?.message || 'Failed to save skill');
			}
		} catch (error) {
			console.error('Error saving skill:', error);
			toast.error(
				error instanceof Error ? error.message : 'Failed to save skill',
			);
		} finally {
			setSaving(false);
		}
	};

	const handleToggleActive = async (skill: AgentSkill, isActive: boolean) => {
		// Optimistic toggle; rolled back on failure
		setSkills((current) =>
			current.map((s) => (s.id === skill.id ? { ...s, isActive } : s)),
		);
		try {
			const response = await apiClient.updateSkill(skill.id, { isActive });
			if (!response.success) {
				throw new Error(response.error?.message || 'Failed to update skill');
			}
		} catch (error) {
			console.error('Error toggling skill:', error);
			setSkills((current) =>
				current.map((s) =>
					s.id === skill.id ? { ...s, isActive: skill.isActive } : s,
				),
			);
			toast.error(
				error instanceof Error ? error.message : 'Failed to update skill',
			);
		}
	};

	const handleDelete = async () => {
		if (!deleteTarget) return;
		try {
			const response = await apiClient.deleteSkill(deleteTarget.id);
			if (response.success) {
				toast.success('Skill deleted');
				await loadSkills();
			} else {
				throw new Error(response.error?.message || 'Failed to delete skill');
			}
		} catch (error) {
			console.error('Error deleting skill:', error);
			toast.error('Failed to delete skill');
		} finally {
			setDeleteTarget(null);
		}
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-text-tertiary">
					Markdown instructions the AI follows when building your apps.
					Active skills apply to new chats only.
				</p>
				<Button size="sm" onClick={openCreate} className="gap-1 shrink-0">
					<Plus className="h-4 w-4" />
					New Skill
				</Button>
			</div>

			{loading ? (
				<div className="flex items-center gap-3">
					<Settings className="h-5 w-5 animate-spin text-text-tertiary" />
					<span className="text-sm text-text-tertiary">
						Loading skills...
					</span>
				</div>
			) : skills.length === 0 ? (
				<div className="flex flex-col items-center gap-2 py-8 text-center">
					<BookOpen className="h-8 w-8 text-text-tertiary" />
					<p className="text-sm text-text-tertiary">
						No skills yet. Create one to teach the AI your conventions -
						design guidelines, preferred libraries, coding standards.
					</p>
				</div>
			) : (
				<div className="space-y-2">
					{skills.map((skill) => (
						<div
							key={skill.id}
							className="flex items-center justify-between gap-3 rounded-md border border-bg-1/40 bg-bg-3 p-3"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<p className="font-medium text-sm truncate">
										{skill.name}
									</p>
									<Badge
										variant={skill.isActive ? 'default' : 'outline'}
										className="text-xs px-1.5 py-0.5 shrink-0"
									>
										{skill.isActive ? 'Active' : 'Inactive'}
									</Badge>
								</div>
								<p className="text-xs text-text-tertiary truncate mt-0.5">
									{skill.description}
								</p>
							</div>
							<div className="flex items-center gap-2 shrink-0">
								<Switch
									checked={skill.isActive ?? false}
									onCheckedChange={(checked) =>
										handleToggleActive(skill, checked)
									}
									aria-label={`Toggle ${skill.name}`}
								/>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => openEdit(skill)}
									className="h-8 w-8 p-0"
									aria-label={`Edit ${skill.name}`}
								>
									<Pencil className="h-3.5 w-3.5" />
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setDeleteTarget(skill)}
									className="h-8 w-8 p-0 text-destructive hover:text-destructive"
									aria-label={`Delete ${skill.name}`}
								>
									<Trash2 className="h-3.5 w-3.5" />
								</Button>
							</div>
						</div>
					))}
				</div>
			)}

			<Dialog open={editorOpen} onOpenChange={setEditorOpen}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							{editingSkill ? 'Edit Skill' : 'New Skill'}
						</DialogTitle>
						<DialogDescription>
							Markdown instructions injected into the AI's context when
							it builds your apps.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="skill-name">Name</Label>
							<Input
								id="skill-name"
								value={formData.name}
								onChange={(e) =>
									setFormData((f) => ({ ...f, name: e.target.value }))
								}
								placeholder="e.g. Design guidelines"
								maxLength={64}
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="skill-description">Description</Label>
							<Input
								id="skill-description"
								value={formData.description}
								onChange={(e) =>
									setFormData((f) => ({
										...f,
										description: e.target.value,
									}))
								}
								placeholder="One line on when this skill applies"
								maxLength={MAX_SKILL_DESCRIPTION_LENGTH}
							/>
						</div>

						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<Label htmlFor="skill-content">Instructions</Label>
								<span className="text-xs text-text-tertiary">
									{formData.content.length.toLocaleString()} /{' '}
									{MAX_SKILL_CONTENT_LENGTH.toLocaleString()}
								</span>
							</div>
							<Textarea
								id="skill-content"
								value={formData.content}
								onChange={(e) =>
									setFormData((f) => ({
										...f,
										content: e.target.value,
									}))
								}
								placeholder={
									'Markdown instructions, e.g.\n\n# Design guidelines\n- Use a dark, minimal palette\n- Prefer Tailwind utility classes over custom CSS'
								}
								className="min-h-[240px] font-mono text-sm"
								maxLength={MAX_SKILL_CONTENT_LENGTH}
							/>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setEditorOpen(false)}
							disabled={saving}
						>
							Cancel
						</Button>
						<Button onClick={handleSave} disabled={saving}>
							{saving
								? 'Saving...'
								: editingSkill
									? 'Save Changes'
									: 'Create Skill'}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={deleteTarget !== null}
				onOpenChange={(open) => !open && setDeleteTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Delete "{deleteTarget?.name}"?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This cannot be undone. Chats already in progress keep the
							version of the skill they started with.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleDelete}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Delete Skill
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
