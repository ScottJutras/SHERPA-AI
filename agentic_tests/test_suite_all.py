from dotenv import load_dotenv
import os
load_dotenv()

from crewai import Task, Crew
from agentic_tests.agents.test_agents import test_agents

# === TEST BLOCKS ===

## 1. Expense Logging (Text)
text_expense_test = Task(
    description="Simulate user sending: 'just got $17.50 of nails and glue from Home Depot today'. Check if the spreadsheet logs this correctly.",
    expected_output="Spreadsheet row with $17.50, items: 'nails and glue', vendor: 'Home Depot', correct date and timestamp.",
    agent=test_agents["expense_logger_agent"]
)

## 2. Expense Logging (Image)
image_expense_test = Task(
    description="Simulate uploading receipt image from RONA for $48.00.",
    expected_output="Row added with amount $48.00, timestamp, vendor = RONA using Document AI.",
    agent=test_agents["expense_logger_agent"]
)

## 3. Expense Logging (Voice)
voice_expense_test = Task(
    description="Simulate voice input: 'Spent $95 on roofing nails and tar from Roofmart yesterday'.",
    expected_output="Parsed as: $95, items: 'roofing nails and tar', vendor: 'Roofmart', correct date and timestamp.",
    agent=test_agents["voice_parser_agent"]
)

## 4. Onboarding
onboarding_test = Task(
    description="Simulate first-time user message. Verify onboarding and spreadsheet creation.",
    expected_output="Assistant should greet, request job name, and create new sheet.",
    agent=test_agents["onboarding_agent"]
)

## 5. Quote Generation
quote_test = Task(
    description="Simulate user requesting a material quote with item list. Verify PDF generation and totals.",
    expected_output="PDF quote should reflect material prices, quantities, subtotals, and total cost.",
    agent=test_agents["quote_generator_agent"]
)

## 6. Chart Creation
chart_test = Task(
    description="User asks to generate a chart of monthly expenses. Verify chart is built and stored or sent.",
    expected_output="Line or bar chart showing monthly totals should be created and handled.",
    agent=test_agents["chart_creator_agent"]
)

## 7. Spreadsheet Email Dispatch
email_dispatch_test = Task(
    description="User requests their spreadsheet to be emailed. Confirm dispatch via SendGrid with correct attachment.",
    expected_output="User receives email with current spreadsheet attached.",
    agent=test_agents["email_dispatch_agent"]
)

## 8. Token Usage Logging
token_tracking_test = Task(
    description="Simulate actions that consume AI tokens. Confirm token usage is logged and does not exceed plan limits.",
    expected_output="User's Firestore tokenUsage field should reflect accurate counts for messages + aiCalls.",
    agent=test_agents["usage_tracker_agent"]
)

## 9. Team Access / Multi-User Logging
team_access_test = Task(
    description="Simulate a second team member adding an expense to the same spreadsheet.",
    expected_output="Second user's entry is correctly logged in the existing project spreadsheet.",
    agent=test_agents["team_access_agent"]
)

## 10. AI Error Detection + Correction (Text)
ai_error_text_test = Task(
    description="User enters an unclear message: 'Logged 20 paint'. AI should detect the error, ask for clarification, correct, then log properly.",
    expected_output="Assistant should respond with sharp, confident tone, request clarification, get final data, and log it with a timestamp.",
    agent=test_agents["ai_error_detection_agent"]
)

## 11. AI Error Detection + Correction (Voice)
ai_error_voice_test = Task(
    description="User sends a vague WhatsApp voice note: 'Spent 55'. AI should transcribe, detect ambiguity, clarify, and log correctly.",
    expected_output="Voice is transcribed, assistant flags lack of detail, asks for missing parts, confirms final entry and logs it with date/time.",
    agent=test_agents["ai_error_detection_agent"]
)

## 12. Revenue Logging Test
revenue_logging_test = Task(
    description="User sends: 'Got paid $750 from roofing job at 10 Dale St today'.",
    expected_output="Revenue log added with amount, source, job reference, and timestamp.",
    agent=test_agents["revenue_logger_agent"]
)

## 13. Revenue Logging (Voice)
revenue_voice_test = Task(
    description="User voice input: 'Just got $600 for siding project on Victoria Street'.",
    expected_output="Voice parsed, revenue entry added with amount, project, and timestamp.",
    agent=test_agents["revenue_logger_agent"]
)

## 14. Bill Logging (Text)
bill_logging_test = Task(
    description="User sends: 'Bell bill for $112 due April 12'. Should log this as a scheduled bill.",
    expected_output="Logged as bill for Bell, amount $112, due April 12, with timestamp of entry.",
    agent=test_agents["bill_logger_agent"]
)

## 15. Financial Strategy Query
financial_strategy_test = Task(
    description="User asks: 'How much do I need to make this month to cover my expenses and rent next month?'.",
    expected_output="Assistant should analyze past revenue and expense logs, then provide target monthly income goal.",
    agent=test_agents["strategy_agent"]
)

## 16. Spreadsheet Job Start
job_start_test = Task(
    description="User types: 'Start job 85 Westmount siding project'. Confirm a new spreadsheet is initialized.",
    expected_output="New project sheet is created and selected as active job.",
    agent=test_agents["job_manager_agent"]
)

# === COMBINED TEST CREW ===
test_suite = Crew(
    agents=list(test_agents.values()),
    tasks=[
        text_expense_test,
        image_expense_test,
        voice_expense_test,
        onboarding_test,
        quote_test,
        chart_test,
        email_dispatch_test,
        token_tracking_test,
        team_access_test,
        ai_error_text_test,
        ai_error_voice_test,
        revenue_logging_test,
        revenue_voice_test,
        bill_logging_test,
        financial_strategy_test,
        job_start_test
    ],
    verbose=True
)

if __name__ == "__main__":
    results = test_suite.kickoff()
    print("\n✅ Mega Test Results:")
    print(results)
