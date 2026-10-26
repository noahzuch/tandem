<script setup lang="ts">
// Code block NodeView: lowlight highlighting (decorations from CodeBlockLowlight) + a language picker.
import { computed } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { lowlight } from '../extensions'

const props = defineProps(nodeViewProps)
const languages = lowlight.listLanguages().sort()
const language = computed({
  get: () => (props.node.attrs.language as string | null) ?? '',
  set: (v: string) => props.updateAttributes({ language: v || null }),
})
</script>

<template>
  <NodeViewWrapper class="code-block" :data-language="language || undefined">
    <select v-model="language" class="code-lang" contenteditable="false" aria-label="Code language" data-testid="code-lang">
      <option value="">plain text</option>
      <option v-if="language && !languages.includes(language)" :value="language">{{ language }}</option>
      <option v-for="l in languages" :key="l" :value="l">{{ l }}</option>
    </select>
    <pre><NodeViewContent as="code" :class="language ? `language-${language} hljs` : 'hljs'" /></pre>
  </NodeViewWrapper>
</template>
