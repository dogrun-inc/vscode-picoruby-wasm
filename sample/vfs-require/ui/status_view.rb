class StatusView
  def initialize(element_id)
    @element = JS.document.getElementById(element_id)
  end

  def clear
    @element.textContent = ''
  end

  def append(message)
    current = @element.textContent
    separator = current.empty? ? '' : "\n"
    @element.textContent = "#{current}#{separator}#{message}"
  end
end