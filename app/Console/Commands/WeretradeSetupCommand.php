<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Actions\ApiKey\CreateApiKey;
use App\Actions\User\CreateUser;
use App\Models\AccessToken;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Console\Command;
use Illuminate\Support\Str;

class WeretradeSetupCommand extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'weretrade:setup
                            {--email=admin@weretrade.com : Admin email address}
                            {--force : Force regenerate MCP access tokens}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Bootstrap weretradeIT multi-persona workspaces (Bob Weber, Hanna Thoma, Corporate) and generate MCP tokens';

    /**
     * Execute the console command.
     */
    public function handle(): int
    {
        $this->info('🚀 Setting up weretradeIT multi-persona social hub...');

        // 1. Ensure Admin User
        $email = (string) $this->option('email');
        $user = User::where('email', $email)->first();

        if (! $user) {
            $this->info("Creating initial weretrade admin user: {$email}");
            $tempPassword = Str::random(16);
            $user = CreateUser::execute([
                'name' => 'weretrade Admin',
                'email' => $email,
                'password' => $tempPassword,
                'email_verified_at' => now(),
            ]);
            $this->warn("Temporary admin password generated: {$tempPassword}");
        }

        // 2. Define Workspaces
        $workspacesConfig = [
            'bob' => [
                'name' => 'Bob Weber — B2B Operations & Logistics',
                'brand_website' => 'https://weretrade.com',
                'brand_description' => 'WeretradeIT Backoffice Operations Specialist for Order Processing, Inventory Management, Carrier Logistics & EU OSS VAT Compliance.',
                'brand_voice_traits' => ['Analytical', 'Pragmatic', 'Professional', 'Efficiency-oriented'],
                'brand_color' => '#1E40AF',
                'content_language' => 'de',
            ],
            'hanna' => [
                'name' => 'Hanna Thoma — Customer Experience & Community',
                'brand_website' => 'https://weretrade.com',
                'brand_description' => 'WeretradeIT Client Support Manager & Vintage Lego Collector Specialist for Vinted, Kleinanzeigen, eBay & Customer Happiness.',
                'brand_voice_traits' => ['Empathetic', 'Enthusiastic', 'Collector-Friendly', 'Warm', 'Supportive'],
                'brand_color' => '#7C3AED',
                'content_language' => 'de',
            ],
            'corporate' => [
                'name' => 'weretradeIT Corporate & BauKlotzBude',
                'brand_website' => 'https://bauklotzbude.de',
                'brand_description' => 'Corporate e-commerce news, rare Lego collector highlights, drops, and marketplace innovations.',
                'brand_voice_traits' => ['Innovative', 'Engaging', 'Trustworthy', 'Authoritative'],
                'brand_color' => '#059669',
                'content_language' => 'de',
            ],
        ];

        $tokens = [];

        foreach ($workspacesConfig as $key => $config) {
            $workspace = Workspace::where('name', $config['name'])->first();

            if (! $workspace) {
                $workspace = Workspace::create([
                    'name' => $config['name'],
                    'account_id' => $user->account_id,
                    'user_id' => $user->id,
                    'brand_website' => $config['brand_website'],
                    'brand_description' => $config['brand_description'],
                    'brand_voice_traits' => $config['brand_voice_traits'],
                    'brand_color' => $config['brand_color'],
                    'content_language' => $config['content_language'],
                ]);
                $workspace->members()->attach($user->id, ['role' => 'admin']);
                $this->line("✅ Created workspace: <info>{$config['name']}</info> ({$workspace->id})");
            } else {
                $workspace->update([
                    'brand_website' => $config['brand_website'],
                    'brand_description' => $config['brand_description'],
                    'brand_voice_traits' => $config['brand_voice_traits'],
                    'brand_color' => $config['brand_color'],
                    'content_language' => $config['content_language'],
                ]);
                $this->line("🔄 Updated workspace: <info>{$config['name']}</info> ({$workspace->id})");
            }

            // Ensure member
            if (! $workspace->members()->where('user_id', $user->id)->exists()) {
                $workspace->members()->attach($user->id, ['role' => 'admin']);
            }

            // Generate or fetch MCP OAuth Grant Token
            $tokenName = "mcp-agent-token-{$key}";
            $existing = AccessToken::where('workspace_id', $workspace->id)
                ->where('name', $tokenName)
                ->first();

            if (! $existing || $this->option('force')) {
                if ($existing && $this->option('force')) {
                    $existing->delete();
                }

                $mcpClient = DB::table('oauth_clients')->where('name', 'weretradeIT MCP Client')->first();
                if (! $mcpClient) {
                    $mcpClientId = (string) Str::uuid();
                    DB::table('oauth_clients')->insert([
                        'id' => $mcpClientId,
                        'name' => 'weretradeIT MCP Client',
                        'secret' => null,
                        'provider' => null,
                        'redirect_uris' => '[]',
                        'grant_types' => json_encode(['authorization_code', 'refresh_token']),
                        'revoked' => false,
                        'created_at' => now(),
                        'updated_at' => now(),
                    ]);
                } else {
                    $mcpClientId = $mcpClient->id;
                }

                $result = $user->createToken($tokenName, ['mcp:use']);
                $tokenModel = AccessToken::findOrFail($result->token->id);
                $tokenModel->forceFill([
                    'client_id' => $mcpClientId,
                    'workspace_id' => $workspace->id,
                ])->saveQuietly();

                $tokens[$key] = [
                    'workspace_id' => (string) $workspace->id,
                    'workspace_name' => $config['name'],
                    'token' => $result->accessToken,
                ];
            } else {
                $tokens[$key] = [
                    'workspace_id' => (string) $workspace->id,
                    'workspace_name' => $config['name'],
                    'token' => '[EXISTING_TOKEN_PERSISTED]',
                ];
            }
        }

        $this->newLine();
        $this->info('🎉 weretradeIT Workspaces & MCP Tokens ready:');
        $this->table(
            ['Key', 'Workspace Name', 'Workspace UUID', 'MCP Token'],
            array_map(fn ($k, $t) => [$k, $t['workspace_name'], $t['workspace_id'], Str::limit($t['token'], 25)], array_keys($tokens), array_values($tokens))
        );

        return self::SUCCESS;
    }
}
