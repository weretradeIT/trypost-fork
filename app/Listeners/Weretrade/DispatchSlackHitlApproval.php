<?php

declare(strict_types=1);

namespace App\Listeners\Weretrade;

use App\Enums\Post\CreatedVia;
use App\Enums\Post\Status as PostStatus;
use App\Events\PostCreated;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class DispatchSlackHitlApproval implements ShouldQueue
{
    /**
     * Handle the event.
     */
    public function handle(PostCreated $event): void
    {
        $webhookUrl = config('services.slack.hitl_webhook_url') ?? env('SLACK_HITL_WEBHOOK_URL');

        if (empty($webhookUrl)) {
            return;
        }

        $post = $event->post;

        // HITL guardrail applies to AI/agent-created posts or drafts
        $isAgentCreated = in_array($post->created_via, [CreatedVia::Mcp, CreatedVia::Api, CreatedVia::Automation], true);
        if (! $isAgentCreated && $post->status !== PostStatus::Draft) {
            return;
        }

        $post->loadMissing(['workspace', 'postPlatforms.socialAccount']);

        $workspaceName = $post->workspace?->name ?? 'weretradeIT';
        $platforms = $post->postPlatforms
            ->map(fn ($p) => ucfirst((string) $p->socialAccount?->platform?->value ?? 'Social'))
            ->filter()
            ->unique()
            ->implode(', ');

        if (empty($platforms)) {
            $platforms = 'Keine Plattform gewählt';
        }

        $scheduledText = $post->scheduled_at
            ? $post->scheduled_at->format('d.m.Y H:i').' UTC'
            : 'Sofort nach Freigabe';

        $appUrl = config('app.url', 'https://social.lair404.xyz');
        $postUrl = "{$appUrl}/posts/{$post->id}";

        $blocks = [
            [
                'type' => 'header',
                'text' => [
                    'type' => 'plain_text',
                    'text' => '📝 Neuer Social Post Entwurf — Freigabe erforderlich (HITL)',
                    'emoji' => true,
                ],
            ],
            [
                'type' => 'section',
                'fields' => [
                    ['type' => 'mrkdwn', 'text' => "*🏢 Workspace:*\n`{$workspaceName}`"],
                    ['type' => 'mrkdwn', 'text' => "*🌐 Ziel-Kanäle:*\n`{$platforms}`"],
                    ['type' => 'mrkdwn', 'text' => "*📅 Timing:*\n{$scheduledText}"],
                    ['type' => 'mrkdwn', 'text' => "*🆔 Post ID:*\n`{$post->id}`"],
                ],
            ],
            [
                'type' => 'section',
                'text' => [
                    'type' => 'mrkdwn',
                    'text' => "*Inhalt:*\n>>> ".Str::limit((string) $post->content, 1200),
                ],
            ],
            [
                'type' => 'actions',
                'elements' => [
                    [
                        'type' => 'button',
                        'text' => ['type' => 'plain_text', 'text' => '✅ Freigeben & Einplanen', 'emoji' => true],
                        'style' => 'primary',
                        'action_id' => 'hitl_approve_post',
                        'value' => (string) $post->id,
                    ],
                    [
                        'type' => 'button',
                        'text' => ['type' => 'plain_text', 'text' => '❌ Verwerfen', 'emoji' => true],
                        'style' => 'danger',
                        'action_id' => 'hitl_reject_post',
                        'value' => (string) $post->id,
                    ],
                    [
                        'type' => 'button',
                        'text' => ['type' => 'plain_text', 'text' => '🌐 In TryPost öffnen', 'emoji' => true],
                        'url' => $postUrl,
                        'action_id' => 'hitl_view_in_trypost',
                    ],
                ],
            ],
            [
                'type' => 'context',
                'elements' => [
                    [
                        'type' => 'mrkdwn',
                        'text' => '🛡️ *weretradeIT HITL Guard* | Erstellt via MCP Copilot | Status: 🟡 *Wartet auf Freigabe*',
                    ],
                ],
            ],
        ];

        try {
            Http::timeout(5)->post($webhookUrl, [
                'text' => "📝 Neuer Social Post Entwurf in {$workspaceName} wartet auf Freigabe",
                'blocks' => $blocks,
            ]);
        } catch (\Throwable $e) {
            Log::warning('[weretrade-hitl] Failed to dispatch Slack notification: '.$e->getMessage());
        }
    }
}
