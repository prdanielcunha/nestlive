import { describe, expect, it } from 'vitest';
import {
  sectionCandidatesFromResults,
  sectionPresentationContext
} from './requestSection';

describe('request section context', () => {
  const presentation = {
    id: 'presentation-1',
    song_id: 'song-44',
    title: 'Promessas',
    type: 'lyrics',
    slide_number: 4,
    slides: [
      { slide_description: 'Intro', text: 'Intro 1' },
      { slide_description: 'Intro', text: 'Intro 2' },
      { slide_description: 'Verso 1', text: 'Primeira linha' },
      { slide_description: 'Verso 1', text: 'Segunda linha' },
      { slide_description: 'Refrão', text: 'Refrão principal' },
      { slide_description: 'Ponte', text: 'Ponte' }
    ]
  };

  it('derives a compact section rail and identifies the current section', () => {
    const context = sectionPresentationContext(
      presentation,
      'holyrics-primary',
      'Holyrics'
    );

    expect(context).not.toBeNull();
    expect(context?.title).toBe('Promessas');
    expect(context?.currentSlideIndex).toBe(3);
    expect(context?.sections.map(section => ({
      label: section.label,
      index: section.index
    }))).toEqual([
      { label: 'Intro', index: 0 },
      { label: 'Verso 1', index: 2 },
      { label: 'Refrão', index: 4 },
      { label: 'Ponte', index: 5 }
    ]);
    expect(context?.currentSectionId).toBe('section:holyrics-primary:2');
  });

  it('does not expose conductor section controls for non-song presentations', () => {
    expect(sectionPresentationContext(
      {
        id: 'bible-1',
        type: 'bible',
        slide_number: 1,
        slides: [{ slide_description: 'João 3:16', text: '...' }]
      },
      'holyrics-primary',
      'Holyrics'
    )).toBeNull();
  });

  it('keeps fuzzy section matching while preserving provider slide indices', () => {
    const results = [{
      commandId: 'cmd-1',
      providerInstanceId: 'holyrics-primary',
      accepted: true,
      latencyMs: 10,
      observedState: {
        currentPresentation: presentation
      }
    }];

    const candidates = sectionCandidatesFromResults(
      results,
      'holyrics-primary',
      'Holyrics',
      'voltar ao refrão'
    );

    expect(candidates[0]).toMatchObject({
      label: 'Refrão',
      index: 4,
      providerId: 'holyrics-primary'
    });
  });
});
