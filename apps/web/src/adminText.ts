export const adminText = {
  en: {
    forgotPassword: "Forgot password?",
    resetPassword: "Reset password",
    resetPasswordHelp:
      "Enter your email and we will request a reset link from this server's configured mail provider.",
    resetPasswordDisabled:
      "Password reset is unavailable because this server has no configured mail provider.",
    resetRequested: "Reset instructions were requested. Check your inbox.",
    newPassword: "New password",
    resetComplete: "Password reset. You can now sign in.",
    backToSignIn: "Back to sign in",
    members: "Members",
    manageMembers: "Manage members",
    removeMember: "Remove member",
    deleteDataset: "Delete dataset",
    deleteDatasetHelp:
      "This removes this workspace's stored dataset. Connected Google Sheets are never changed.",
    confirmDatasetName: "Enter the exact dataset name to continue",
    deleteAccount: "Delete account",
    deleteAccountHelp:
      "This permanently removes your sign-in account and sessions. Team records remain, with your attribution removed.",
    transferOwnership:
      "Transfer ownership of these workspaces before deleting your account:",
    confirmAccountName: "Enter your exact account name",
    confirmAccountEmail: "Enter your exact account email",
    currentPasswordOptional: "Current password (optional with a fresh session)",
    accountDeletionFailed: "Account deletion could not be completed.",
  },
  ko: {
    forgotPassword: "비밀번호를 잊으셨나요?",
    resetPassword: "비밀번호 재설정",
    resetPasswordHelp:
      "이메일을 입력하면 이 서버에 설정된 메일 제공업체로 재설정 링크 발송을 요청합니다.",
    resetPasswordDisabled:
      "이 서버에 메일 제공업체가 설정되어 있지 않아 비밀번호 재설정을 사용할 수 없습니다.",
    resetRequested: "재설정 안내 발송을 요청했습니다. 받은편지함을 확인해 주세요.",
    newPassword: "새 비밀번호",
    resetComplete: "비밀번호를 재설정했습니다. 이제 로그인할 수 있습니다.",
    backToSignIn: "로그인으로 돌아가기",
    members: "구성원",
    manageMembers: "구성원 관리",
    removeMember: "구성원 제거",
    deleteDataset: "데이터세트 삭제",
    deleteDatasetHelp:
      "이 작업 공간에 저장된 데이터세트만 삭제합니다. 연결된 Google Sheets는 절대 변경하지 않습니다.",
    confirmDatasetName: "계속하려면 정확한 데이터세트 이름을 입력하세요",
    deleteAccount: "계정 삭제",
    deleteAccountHelp:
      "로그인 계정과 모든 세션을 영구히 삭제합니다. 팀 기록은 유지되며, 회원님의 작성자 표시는 제거됩니다.",
    transferOwnership: "계정을 삭제하기 전에 다음 작업 공간의 소유권을 이전하세요:",
    confirmAccountName: "정확한 계정 이름 입력",
    confirmAccountEmail: "정확한 계정 이메일 입력",
    currentPasswordOptional: "현재 비밀번호 (최근 로그인 세션이면 선택 사항)",
    accountDeletionFailed: "계정 삭제를 완료하지 못했습니다.",
  },
} as const;
